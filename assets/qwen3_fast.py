# A faster inner loop for the Qwen3-TTS PyTorch runtime.
#
# The reference implementation (qwen_tts) produces one 12 Hz frame per step
# of the talker, and for each frame asks its code predictor for the frame's
# other 15 codebook tokens by calling transformers' generate() on it: a
# whole generation pass, with its logits processors, stopping criteria,
# cache allocation and per-step bookkeeping, for 15 tokens of a 4-layer
# model. Profiled on a laptop with an NVIDIA GPU that was 19.2 s of CPU for 6.6 s of
# audio, the GPU idle between tiny kernels, and speech slower than realtime
# by 2.7x on a machine that should be several times faster than it.
#
# This module replaces that one call with a plain loop over the same
# weights: one forward per token with the model's own KV cache, and the
# same sampling the reference asks for (temperature, top-k, top-p,
# multinomial) in the order transformers applies them. On a CUDA device
# the loop is recorded once as a CUDA graph and replayed, which launches
# its 15 steps' kernels at once instead of one by one from Python (see
# _PredictorGraphs). Nothing about the talker, the prompts or the codec
# changes, so the voice is the same; the tokens differ only as any two
# sampled runs differ. The reference path is kept and restored on the
# first exception, so a runtime this was not written against still
# speaks, only slower.
import copy
import functools

import torch


class _Result:
    """What the talker reads from the predictor's answer: `.sequences`."""

    __slots__ = ("sequences",)

    def __init__(self, sequences):
        self.sequences = sequences


def _sample(logits, do_sample, temperature, top_k, top_p):
    """One token per row of `logits`, the way transformers' _sample does it."""
    if not do_sample:
        return torch.argmax(logits, dim=-1, keepdim=True)
    logits = logits.float()
    if temperature is not None and temperature > 0 and temperature != 1.0:
        logits = logits / temperature
    if top_k is not None and 0 < top_k < logits.shape[-1]:
        kth = torch.topk(logits, top_k, dim=-1).values[..., -1, None]
        logits = logits.masked_fill(logits < kth, float("-inf"))
    if top_p is not None and 0 < top_p < 1.0:
        sorted_logits, sorted_idx = torch.sort(logits, descending=False, dim=-1)
        cumulative = sorted_logits.softmax(dim=-1).cumsum(dim=-1)
        remove = cumulative <= (1 - top_p)
        remove[..., -1] = False
        drop = remove.scatter(-1, sorted_idx, remove)
        logits = logits.masked_fill(drop, float("-inf"))
    probs = torch.softmax(logits, dim=-1)
    return torch.multinomial(probs, num_samples=1)


def _find_code_predictor(model):
    """The talker's code predictor, wherever the wrapper keeps the talker."""
    for owner in (model, getattr(model, "model", None)):
        talker = getattr(owner, "talker", None)
        predictor = getattr(talker, "code_predictor", None)
        if predictor is not None and hasattr(predictor, "generate") and hasattr(predictor, "lm_head"):
            return predictor
    return None


def _predictor_loop(predictor, inputs_embeds, steps, do_sample, temperature, top_k, top_p):
    """The frame's other codebooks, one forward per token with the model's own KV cache."""
    out = predictor(inputs_embeds=inputs_embeds, use_cache=True, return_dict=True)
    cache = out.past_key_values
    token = _sample(out.logits[:, -1, :], do_sample, temperature, top_k, top_p)
    tokens = [token]
    for step in range(1, steps):
        out = predictor(input_ids=token, past_key_values=cache, use_cache=True, generation_steps=step, return_dict=True)
        cache = out.past_key_values
        token = _sample(out.logits[:, -1, :], do_sample, temperature, top_k, top_p)
        tokens.append(token)
    return torch.cat(tokens, dim=-1)


class _PredictorGraphs:
    """
    The loop above, recorded once per input shape and sampling setting as a
    CUDA graph and replayed from then on. The loop is bound by launching
    its kernels, not by running them (profiled: 6,500 launches per frame,
    the GPU busy a quarter of the time), and a graph launches them all at
    once: 96 ms per frame became 17 on a laptop with an NVIDIA GPU, and the engine
    went from 1.65x slower than speech to 0.75x. No compiler is involved,
    which is what rules torch.compile out on users' Windows machines. The
    tokens are the eager loop's exactly under greedy decoding (checked over
    real inputs); under sampling the generator advances per replay as it
    does eagerly. A graph needs the same shapes every time, so it is
    recorded for `rows` sequences and a smaller batch rides in the first
    rows of it (a replay costs the same for eight rows as for one): one
    recording, about half a second, rather than one per batch size in the
    middle of a sentence.
    """

    def __init__(self, predictor, rows=8):
        self.predictor = predictor
        self.rows = rows
        self.graphs = {}

    def run(self, inputs_embeds, steps, do_sample, temperature, top_k, top_p):
        batch = inputs_embeds.shape[0]
        if batch > self.rows:
            return _predictor_loop(self.predictor, inputs_embeds, steps, do_sample, temperature, top_k, top_p)
        key = (tuple(inputs_embeds.shape[1:]), inputs_embeds.dtype, bool(do_sample), float(temperature or 0), int(top_k or 0), float(top_p or 0), steps)
        entry = self.graphs.get(key)
        if entry is None:
            entry = self.graphs[key] = self._record(inputs_embeds, steps, do_sample, temperature, top_k, top_p)
        graph, static_in, static_out = entry
        static_in[:batch].copy_(inputs_embeds)
        graph.replay()
        return static_out[:batch].clone()

    def _record(self, inputs_embeds, steps, do_sample, temperature, top_k, top_p):
        static_in = inputs_embeds.new_zeros((self.rows,) + tuple(inputs_embeds.shape[1:]))
        static_in[: inputs_embeds.shape[0]].copy_(inputs_embeds)
        # Warm up on a side stream first (the allocator and cuBLAS settle),
        # as torch's own recipe for capture has it.
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for _ in range(2):
                _predictor_loop(self.predictor, static_in, steps, do_sample, temperature, top_k, top_p)
        torch.cuda.current_stream().wait_stream(side)
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            static_out = _predictor_loop(self.predictor, static_in, steps, do_sample, temperature, top_k, top_p)
        return graph, static_in, static_out


def _on_cuda(module):
    try:
        return next(module.parameters()).device.type == "cuda"
    except StopIteration:
        return False


def install(model, log=lambda s: None, graphs=True, rows=8):
    """
    Replace the code predictor's generate() on `model` (a qwen_tts
    Qwen3TTSModel) with the loop above, replayed as CUDA graphs where the
    model is on a CUDA device. Returns True when installed; the graphs are
    given up on the first failure (the loop then runs eagerly), and the
    original generate() is put back the first time the loop itself fails.
    """
    predictor = _find_code_predictor(model)
    if predictor is None:
        log("fast path: no code predictor found on this runtime; reference generation kept")
        return False
    original = predictor.generate
    groups = len(predictor.lm_head)
    recorded = _PredictorGraphs(predictor, rows) if graphs and _on_cuda(predictor) else None

    def fast_generate(inputs_embeds=None, max_new_tokens=None, do_sample=True, top_p=1.0, top_k=50, temperature=0.9, **_):
        nonlocal recorded
        steps = int(max_new_tokens) if max_new_tokens else groups
        try:
            with torch.inference_mode():
                if recorded is not None:
                    try:
                        return _Result(recorded.run(inputs_embeds, steps, do_sample, temperature, top_k, top_p))
                    except Exception as e:  # this torch or driver cannot record it: launch the steps one by one
                        recorded = None
                        log(f"fast path: CUDA graphs given up ({type(e).__name__}: {e}); the predictor's steps are launched one by one")
                return _Result(_predictor_loop(predictor, inputs_embeds, steps, do_sample, temperature, top_k, top_p))
        except Exception as e:  # any surprise: the reference path, from now on
            predictor.generate = original
            log(f"fast path failed ({type(e).__name__}: {e}); reference generation restored")
            return original(
                inputs_embeds=inputs_embeds,
                max_new_tokens=max_new_tokens,
                do_sample=do_sample,
                top_p=top_p,
                top_k=top_k,
                temperature=temperature,
                output_hidden_states=True,
                return_dict_in_generate=True,
            )

    predictor.generate = fast_generate
    log(f"fast path: code predictor sampled directly ({groups} codebooks per frame{', as CUDA graphs' if recorded else ''})")
    return True


class Cancelled(Exception):
    """Raised inside the talker's step when the request was cancelled: it ends generation at once."""


def _find_talker(model):
    for owner in (model, getattr(model, "model", None)):
        talker = getattr(owner, "talker", None)
        if talker is not None and hasattr(talker, "forward"):
            return talker
    return None


class FrameTap:
    """
    Reports every frame the talker finishes while a generation runs.

    The talker's forward returns each step's codec ids (all codebooks of the
    frame just completed) in its `hidden_states`; wrapping the bound forward
    for the duration of one generation is enough to see them as they are
    made, which is what lets audio be decoded and played before the whole
    utterance exists. Used as a context manager; `on_frame` receives a
    [batch, codebooks] tensor and may raise Cancelled.
    """

    def __init__(self, model, on_frame):
        self.talker = _find_talker(model)
        self.on_frame = on_frame

    def __enter__(self):
        talker = self.talker
        if talker is None:
            return self
        original = talker.forward
        on_frame = self.on_frame

        # transformers inspects forward's signature to validate its kwargs;
        # the wrapper has to show the original's.
        @functools.wraps(original)
        def forward(*args, **kwargs):
            out = original(*args, **kwargs)
            hidden = getattr(out, "hidden_states", None)
            if isinstance(hidden, tuple) and len(hidden) == 2 and hidden[1] is not None:
                on_frame(hidden[1])
            return out

        talker.forward = forward
        return self

    def __exit__(self, *_):
        if self.talker is not None:
            try:
                del self.talker.forward  # the class method shows through again
            except AttributeError:
                pass
        return False


def eos_token_id(model):
    """The first-codebook value that marks the end of speech, or None where the config does not say."""
    for owner in (model, getattr(model, "model", None)):
        config = getattr(owner, "config", None)
        talker = getattr(config, "talker_config", None)
        eos = getattr(talker, "codec_eos_token_id", None)
        if eos is not None:
            return int(eos)
    return None


def decode_codes(model, codes, ref_codes=None, decode=None):
    """
    The audio for a run of frames, decoded the way the reference does it:
    a clone's reference codes in front, and their share of the audio cut
    off. The codec decoder is causal, so the audio for a prefix of the
    frames is the same audio the whole utterance decodes to over those
    frames, and each part can be handed out as soon as it is decoded.
    Returns (float32 samples, sample rate).
    """
    tokenizer = getattr(getattr(model, "model", model), "speech_tokenizer")
    full = codes if ref_codes is None else torch.cat([ref_codes.to(codes.device), codes], dim=0)
    wavs, sr = (decode or tokenizer.decode)([{"audio_codes": full}])
    wav = wavs[0]
    if hasattr(wav, "detach"):
        wav = wav.detach().float().cpu().numpy()
    wav = wav.reshape(-1)
    if ref_codes is not None:
        cut = int(int(ref_codes.shape[0]) / max(int(full.shape[0]), 1) * wav.shape[0])
        wav = wav[cut:]
    return wav, int(sr)


def decoder_module(model):
    """The codec decoder as an nn.Module, for casting; raises when the runtime keeps it elsewhere."""
    tokenizer = getattr(getattr(model, "model", model), "speech_tokenizer")
    inner = getattr(tokenizer, "model", None)
    if inner is None or not hasattr(inner, "float"):
        raise AttributeError("speech_tokenizer.model")
    return inner


def stream_decoder(model):
    """A fresh StreamDecoder over the runtime's codec decoder; raises when the runtime keeps it elsewhere."""
    inner = decoder_module(model)
    dec = getattr(inner, "decoder", None)
    if dec is None or not hasattr(dec, "pre_transformer") or not hasattr(dec, "upsample"):
        raise AttributeError("speech_tokenizer.model.decoder")
    return StreamDecoder(dec)



class StreamDecoder:
    """
    The codec decoder run frame by frame, with the state a whole decode
    carries between frames kept between calls: each causal convolution's
    last few inputs (what its left padding stands in for at the start),
    the transposed convolutions' previous frame, and the transformer's KV
    cache. Feeding the frames of an utterance in parts then produces, sample
    for sample, the audio of decoding them at once (checked: 2e-6 apart in
    float32), and each part costs only its own frames: the whole-prefix
    decode it replaces cost the prefix and the 135-frame voice reference
    every time, 200-300 ms a part against 30.

    Primed with a clone's reference codes once; `copy()` hands each
    utterance of that voice its own state without decoding the reference
    again.
    """

    def __init__(self, decoder):
        self.dec = decoder
        self.cache = None
        self.state = {}

    def copy(self):
        other = StreamDecoder(self.dec)
        other.cache = copy.deepcopy(self.cache)
        other.state = {k: v.clone() for k, v in self.state.items()}
        return other

    def _conv(self, m, x):
        """A causal stride-1 convolution over new samples, with the samples before them in place of the zero padding."""
        pad = m.padding
        if pad == 0:
            return m.conv(x)
        prev = self.state.get(id(m))
        if prev is None:
            prev = x.new_zeros(x.shape[0], x.shape[1], pad)
        joined = torch.cat([prev, x], dim=-1)
        self.state[id(m)] = joined[..., -pad:]
        return m.conv(joined)

    def _transconv(self, m, x):
        """A transposed convolution (kernel 2r, stride r): each output block depends on its own frame and the one before."""
        prev = self.state.get(id(m))
        self.state[id(m)] = x[..., -1:]
        joined = x if prev is None else torch.cat([prev, x], dim=-1)
        y = m.conv(joined)
        if m.right_pad > 0:
            y = y[..., : y.shape[-1] - m.right_pad]
        if prev is not None:
            y = y[..., m.conv.stride[0] :]
        return y

    def _convnext(self, m, h):
        x = self._conv(m.dwconv, h).permute(0, 2, 1)
        x = m.pwconv2(m.act(m.pwconv1(m.norm(x))))
        return h + (m.gamma * x).permute(0, 2, 1)

    def _residual(self, m, h):
        x = self._conv(m.conv1, m.act1(h))
        x = self._conv(m.conv2, m.act2(x))
        return x + h

    def _block(self, m, h):
        for part in m.block:
            name = type(part).__name__
            if name.endswith("CausalTransConvNet"):
                h = self._transconv(part, h)
            elif name.endswith("ResidualUnit"):
                h = self._residual(part, h)
            else:
                h = part(h)
        return h

    def feed(self, codes):
        """Frames [n, codebooks] to their samples, float32 [n * hop]."""
        dec = self.dec
        c = codes.clamp(min=0).T.unsqueeze(0).to(next(dec.parameters()).device)
        hidden = dec.quantizer.decode(c)
        hidden = self._conv(dec.pre_conv, hidden).transpose(1, 2)
        out = dec.pre_transformer(inputs_embeds=hidden, past_key_values=self.cache, use_cache=True)
        self.cache = out.past_key_values
        hidden = out.last_hidden_state.permute(0, 2, 1)
        for blocks in dec.upsample:
            for block in blocks:
                name = type(block).__name__
                if name.endswith("CausalTransConvNet"):
                    hidden = self._transconv(block, hidden)
                elif name.endswith("ConvNeXtBlock"):
                    hidden = self._convnext(block, hidden)
                else:
                    hidden = block(hidden)
        wav = hidden
        for block in dec.decoder:
            name = type(block).__name__
            if name.endswith("CausalConvNet"):
                wav = self._conv(block, wav)
            elif name.endswith("DecoderBlock"):
                wav = self._block(block, wav)
            else:
                wav = block(wav)
        return wav.clamp(min=-1, max=1).reshape(-1)
