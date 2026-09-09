// Protocol tests for the Python synthesis daemons, run against FAKE model
// modules (no weights needed): streaming parts, cancel mid-generation,
// urgent-before-background scheduling, runaway cutoff, edge trimming.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PyTtsDaemon } = require("../../out/tts/pyDaemon.js");
const { parseWav } = require("../../out/tts/wav.js");
const { ROOT, tmpDir, writeWav, pythonWithNumpy, until, sleep } = require("../helpers");

const python = pythonWithNumpy();

function fakeModules(dir) {
  // sherpa_onnx fake: generate() calls the callback per "sentence" with a
  // tone whose length follows the text length; sleeps so cancels can land.
  fs.mkdirSync(path.join(dir, "sherpa_onnx"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sherpa_onnx", "__init__.py"),
    `
import math, time
class _Cfg:
    def __init__(self, **kw): pass
OfflineTtsKokoroModelConfig = OfflineTtsModelConfig = OfflineTtsConfig = _Cfg
class _Audio:
    def __init__(self, samples): self.samples = samples
class OfflineTts:
    def __init__(self, cfg): self.sample_rate = 24000
    def generate(self, text, sid=0, speed=1.0, callback=None):
        sentences = [s for s in text.split(". ") if s]
        out = []
        for s in sentences:
            n = int(24000 * (0.05 * len(s.split()) + 0.3))
            sil = [0.0] * 2400  # 0.1s silence at the edges of each sentence
            tone = [0.3 * math.sin(i / 8.0) for i in range(n)]
            chunk = sil + tone + sil
            time.sleep(0.15)
            out.extend(chunk)
            if callback is not None and callback(chunk, 1.0) == 0:
                break
        return _Audio(out)
`
  );
  // mlx_audio fake: generate() yields streaming chunks; a text containing
  // "RUNAWAY" never stops (tests the cutoff).
  fs.mkdirSync(path.join(dir, "mlx_audio", "tts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx_audio", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "tts", "utils.py"),
    `
import os, time, numpy as np
class _R:
    def __init__(self, a): self.audio = a; self.sample_rate = 24000
class _Conds(np.ndarray):
    # Stands in for the real Conditionals: indexable like the samples it was
    # made from (tests read the pitch off them) and carrying .gen, the ref_dict
    # s3gen.inference() takes for voice conversion.
    pass
class _S3Gen:
    def __call__(self, speech_tokens, ref_dict, finalize=True):
        # The real model's __call__ returns the waveform alone; streaming
        # drops the last 3 tokens until finalize (the flow's lookahead).
        n = int(np.asarray(speech_tokens).shape[-1]) - (0 if finalize else 3)
        t = np.arange(int(24000 * max(n, 0) / 25.0)) / 24000.0
        return (0.3 * np.sin(2 * np.pi * 300.0 * t)).astype(np.float32)
    def inference(self, speech_tokens, ref_dict, finalize=True):
        # One second of tone per 25 tokens (the S3 rate), at the pitch of the
        # reference, so a test can check both the length and whose voice.
        n = int(np.asarray(speech_tokens).shape[-1])
        secs = n / 25.0
        r = np.asarray(ref_dict["ref"], dtype=np.float32).reshape(-1)
        zc = int(np.count_nonzero(np.diff(np.signbit(r)))) if r.size > 100 else 0
        freq = max(80.0, zc / 2.0 / (r.size / 24000.0)) if zc else 300.0
        t = np.arange(int(24000 * secs)) / 24000.0
        return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32), None
class _KV:
    def __init__(self): self.keys = None; self.values = None; self.offset = 0; self.state = None
class _PreTransformer:
    def make_cache(self): return [_KV()]
class _Decoder:
    # What the daemon's priming touches on the real vocoder: a streaming step
    # that keeps a transformer cache, a reset, and the module walk it snapshots.
    def __init__(self): self._transformer_cache = None; self.pre_transformer = _PreTransformer(); self.steps = []
    def reset_streaming_state(self): self._transformer_cache = None
    def streaming_step(self, codes):
        if self._transformer_cache is None: self._transformer_cache = self.pre_transformer.make_cache()
        self.steps.append(tuple(np.asarray(codes).shape))
        return np.zeros((1, 1, 2000 * int(np.asarray(codes).shape[-1])), dtype=np.float32)
    def named_modules(self): return []
class _SpeechTokenizer:
    def __init__(self): self.decoder = _Decoder()
class _Model:
    s3gen = _S3Gen()
    sample_rate = 24000
    def __init__(self):
        self.speech_tokenizer = _SpeechTokenizer()
        self._icl_cache = {}
    def _s3_tokenizer(self, mel, lengths):
        # 25 tokens per second of 16 kHz audio (mel frames are 10 ms apart).
        frames = int(np.asarray(mel).shape[-1])
        n = max(1, frames // 4)
        return np.zeros((1, n), dtype=np.int32), np.array([n])
    def prepare_conditionals(self, ref_wav, ref_sr=24000, exaggeration=0.5):
        a = np.asarray(ref_wav, dtype=np.float32).reshape(-1)
        c = a.view(_Conds)
        c.gen = {"ref": a}
        c.t3 = object()
        return c
    # The token model, as the streaming loop drives it: a fixed number of
    # tokens (STREAM_TOKENS_FAKE) and then the stop token, so the number of
    # parts a test sees is deterministic.
    class _T3:
        class hp:
            start_speech_token = 6561
            stop_speech_token = 6562
            start_text_token = 255
            stop_text_token = 0
        class tfmr:
            class model:
                def __init__(self, inputs=None, input_embeddings=None, cache=None):
                    self.h = np.zeros((int(np.asarray(input_embeddings).shape[0]), 1, 4), dtype=np.float32)
                def __getitem__(self, k): return self.h[k]
                def squeeze(self, ax): return self.h.squeeze(ax)
            model = staticmethod(lambda inputs=None, input_embeddings=None, cache=None: np.zeros((int(np.asarray(input_embeddings).shape[0]), 1, 4), dtype=np.float32))
        class speech_pos_emb:
            @staticmethod
            def get_fixed_embedding(i): return np.zeros((1, 1, 4), dtype=np.float32)
        def __init__(self): self.step = 0
        def _prepare_inference_context(self, t3_cond=None, text_tokens=None, cfg_weight=0.5):
            if os.environ.get("STREAM_BREAK"):
                raise AttributeError("no such attribute: an mlx-audio that moved things around")
            return np.zeros((int(np.asarray(text_tokens).shape[0]), 3, 4), dtype=np.float32)
        def speech_head(self, h):
            # Logits whose argmax is a speech token until the budget is spent.
            if os.environ.get("STREAM_SLOW"):
                time.sleep(0.01)
            b = int(np.asarray(h).shape[0])
            logits = np.full((b, 1, 6600), -1e9, dtype=np.float32)
            self.step += 1
            logits[:, 0, 6562 if self.step > int(os.environ.get("STREAM_TOKENS_FAKE", "130")) else 100 + (self.step % 7)] = 0.0
            return logits
        def speech_emb(self, ids): return np.zeros((1, 1, 4), dtype=np.float32)
        def parameters(self): return {}
    t3 = _T3()
    def _tokenize_text(self, text, lang): return np.zeros((1, max(1, len(text) // 4)), dtype=np.int32)
    def _generate_icl(self, text, ref_audio, ref_text, language="english", temperature=0.8, top_p=0.95, repetition_penalty=1.1, max_tokens=0, stream=False, streaming_interval=0.5, **kw):
        # The clone path the daemon calls directly, so its own penalty is the
        # one used; generate() would have raised it to 1.5.
        os.environ["ICL_PENALTY_SEEN"] = str(repetition_penalty)
        return self.generate(text=text, stream=stream, streaming_interval=streaming_interval, ref_text=ref_text, ref_audio=ref_audio)
    def generate(self, text="", stream=False, streaming_interval=0.5, ref_text=None, ref_audio=None, conds=None, **kw):
        if isinstance(ref_audio, str):
            # The Qwen3 daemon passes the reference as a path; tests that never
            # made one name a file that does not exist.
            try:
                import wave
                with wave.open(ref_audio, "rb") as w:
                    ref_audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            except Exception:
                ref_audio = None
        # Dense scripts (CJK) carry no spaces: duration follows characters, so a
        # daemon that budgets by whitespace words truncates them.
        dense = sum(1 for c in text if 0x3040 <= ord(c) <= 0xD7AF)
        words = len(text.split()) + dense / 2.0
        secs = 0.2 * words + 0.4
        if "RUNAWAY" in text: secs = 60
        t = np.arange(int(24000 * secs)) / 24000.0
        # The reference decides the pitch: a test can then hear which voice
        # a request actually used. Qwen3 passes a transcript, Chatterbox only
        # the loaded reference samples, so derive it from whichever is there.
        if ref_text:
            freq = 220 + 40 * (len(ref_text) % 10)
            # The real model keys its reference cache on (text, fingerprint) and
            # fills it before the first token; 12.5 codec tokens per second.
            if ref_audio is not None:
                r = np.asarray(ref_audio, dtype=np.float32).reshape(-1)
                self._icl_cache[(ref_text, (r.size, float(r.sum())))] = (np.zeros((1, 16, max(1, r.size // 1920)), dtype=np.int32), None)
                self.speech_tokenizer.decoder.reset_streaming_state()
        elif ref_audio is not None or conds is not None:
            r = np.asarray(ref_audio if ref_audio is not None else conds, dtype=np.float32).reshape(-1)
            if r.size > 100 and float(np.abs(r).max()) > 0.05:
                # A real waveform: mirror its own pitch, so a test can tell
                # which reference CONTENT was used, not just which path.
                zc = int(np.count_nonzero(np.diff(np.signbit(r))))
                freq = max(80.0, zc / 2.0 / (r.size / 24000.0))
            else:
                tag = int(round(float(r[0]) * 1000)) if r.size else 0
                freq = 220 + 40 * (tag % 10)
        else:
            freq = 220
        a = (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        a[:2400] = 0; a[-2400:] = 0  # edge silence
        if not stream:
            yield _R(a); return
        step = int(24000 * streaming_interval)
        for i in range(0, a.size, step):
            time.sleep(0.05)
            if ref_text:
                self.speech_tokenizer.decoder.streaming_step(np.zeros((1, 16, max(1, step // 1920)), dtype=np.int32))
            yield _R(a[i:i + step])
def load_model(model_id): return _Model()
`
  );
  // What the streaming loop imports from mlx and mlx_audio.
  fs.mkdirSync(path.join(dir, "mlx_audio", "lm", "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx_audio", "lm", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "mlx_audio", "lm", "models", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "mlx_audio", "lm", "models", "cache.py"), "def make_prompt_cache(m): return []\n");
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "lm", "sample_utils.py"),
    `
import numpy as np
def make_sampler(temp=1.0, top_p=1.0, min_p=0.0):
    return lambda logits: np.argmax(np.asarray(logits), axis=-1)
def make_logits_processors(logit_bias=None, repetition_penalty=1.0, repetition_context_size=0):
    return []
`
  );
  // The Qwen3 module the daemon loads a reference through, as the model does.
  fs.mkdirSync(path.join(dir, "mlx_audio", "tts", "models", "qwen3_tts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "models", "qwen3_tts", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "tts", "models", "qwen3_tts", "qwen3_tts.py"),
    `
import wave, numpy as np
def load_audio(path, sample_rate=24000):
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
`
  );
  fs.mkdirSync(path.join(dir, "mlx_audio", "tts", "models", "chatterbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "models", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "models", "chatterbox", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "tts", "models", "chatterbox", "chatterbox.py"),
    `
import numpy as np
SPEECH_VOCAB_SIZE = 6561
def drop_invalid_tokens(x): return np.asarray(x).reshape(-1)
`
  );
  // torch + chatterbox fakes for the PyTorch Chatterbox daemon, the only
  // Chatterbox path on Linux and Windows. The fake speaks for a length that
  // follows the text (per character for CJK) and at a pitch that follows the
  // reference path, and "RUNAWAY" never stops.
  fs.mkdirSync(path.join(dir, "torch"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "torch", "__init__.py"),
    `
import types
backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
cuda = types.SimpleNamespace(is_available=lambda: False)
`
  );
  fs.mkdirSync(path.join(dir, "chatterbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "chatterbox", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "chatterbox", "mtl_tts.py"),
    `
import numpy as np
class ChatterboxMultilingualTTS:
    # Mirrors chatterbox-tts 0.1.7: the checkpoint's own speaker lives in
    # self.conds, and BOTH prepare_conditionals() and a prompted generate()
    # REPLACE it in place, so a prompt-less generate() afterwards speaks the
    # last clone unless the caller restored the built-in conds itself.
    sr = 24000
    prepared = 0
    @classmethod
    def from_pretrained(cls, device):
        m = cls(); m.conds = 0; return m
    def get_supported_languages(self): return {"en": "English", "ar": "Arabic", "zh": "Chinese"}
    def prepare_conditionals(self, path, exaggeration=0.5):
        ChatterboxMultilingualTTS.prepared += 1
        self.conds = sum(ord(c) for c in str(path)) % 10 or 1
    def generate(self, text="", language_id="en", audio_prompt_path=None, **kw):
        if audio_prompt_path: self.prepare_conditionals(audio_prompt_path)
        dense = sum(1 for c in text if 0x3040 <= ord(c) <= 0xD7AF)
        words = len(text.split()) + dense / 2.0
        secs = 0.2 * words + 0.4
        if "RUNAWAY" in text: secs = 60
        if "PREPARED" in text: secs = 0.4 + 0.1 * ChatterboxMultilingualTTS.prepared
        t = np.arange(int(24000 * secs)) / 24000.0
        a = (0.3 * np.sin(2 * np.pi * (220 + 40 * self.conds) * t)).astype(np.float32)
        a[:2400] = 0; a[-2400:] = 0
        return a
`
  );
  // mlx.core and the S3 tokenizer helper, imported only by the voice-conversion path.
  fs.mkdirSync(path.join(dir, "mlx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "mlx", "core.py"),
    `
import numpy as _np
int32 = _np.int32
def concatenate(xs, axis=0): return _np.concatenate([_np.asarray(x) for x in xs], axis=axis)
def full(shape, v, dtype=None): return _np.full(shape, v, dtype=dtype)
def sum(x): return _np.sum(_np.asarray(x))
def argsort(x): return _np.argsort(_np.asarray(x), kind="stable")
def take(x, idx): return _np.take(_np.asarray(x).reshape(-1), _np.asarray(idx))
def expand_dims(x, ax): return _np.expand_dims(_np.asarray(x), ax)
class random:
    @staticmethod
    def seed(s): pass

import numpy as np
def array(x, dtype=None): return np.asarray(x, dtype=dtype)
def eval(*args): pass
`
  );
  fs.mkdirSync(path.join(dir, "mlx_audio", "tts", "models", "chatterbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "models", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "models", "chatterbox", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "tts", "models", "chatterbox", "s3tokenizer.py"),
    `
import numpy as np
def log_mel_spectrogram(a):
    a = np.asarray(a).reshape(-1)
    return np.zeros((80, max(1, a.size // 160)), dtype=np.float32)  # 10 ms frames
`
  );
  // mlx_audio.utils.load_audio: Chatterbox loads reference samples itself, so
  // the fake returns an array that encodes which file was asked for.
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "utils.py"),
    `
import numpy as np
def load_audio(path, sample_rate=24000, **kw):
    try:  # a real file: hand back its samples so content changes are visible
        import wave as _w
        with _w.open(path) as w:
            return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    except Exception:  # a path that does not exist: encode the path itself
        tag = sum(ord(c) for c in str(path)) % 10
        return np.full(int(sample_rate * 0.5), (tag + 1) / 1000.0, dtype=np.float32)
`
  );
}

function daemon(script, cfg, env) {
  const errors = [];
  const d = new PyTtsDaemon(python, path.join(ROOT, "assets", script), cfg, (m) => errors.push(m), {
    readyTimeoutMs: 20000,
    env,
  });
  return { d, errors };
}

test(
  "Kokoro daemon: streaming parts, cancel mid-generation, urgent first, edge trim",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const env = { PYTHONPATH: dir };
    const { d, errors } = daemon("kokoro_daemon.py", { model: "m", voices: "v", tokens: "t", data_dir: "d" }, env);
    try {
      await d.ready;
      const out = tmpDir("cv-parts-");
      // 1) streaming parts arrive, final flagged, files valid; first part has no long leading silence
      const parts = [];
      await d.request(
        {
          text: "One two three. Four five six. Seven eight nine.",
          sid: 0,
          speed: 1,
          out: path.join(out, "a.wav"),
          stream: true,
          priority: 1,
        },
        (f, fin) => parts.push([f, fin])
      ).promise;
      assert.equal(parts.length, 4); // 3 sentences + the closing breath part
      assert.deepEqual(
        parts.map((p) => p[1]),
        [false, false, false, true]
      );
      // Non-final sentence parts are padded to a ~0.45s pause; the final part keeps a ~0.35s tail.
      const tailOf = (f) => {
        const b = fs.readFileSync(f);
        const i = parseWav(b);
        const pcm = b.subarray(i.dataOffset);
        let n = pcm.length / 2,
          t = 0;
        while (t < n && Math.abs(pcm.readInt16LE((n - 1 - t) * 2)) < 300) t++;
        return t / i.sampleRate;
      };
      // A full stop gets a reader's pause (0.45s +-12% variation).
      assert.ok(Math.abs(tailOf(parts[0][0]) - 0.45) < 0.09, `sentence pause ${tailOf(parts[0][0])}`);
      assert.ok(Math.abs(parseWav(fs.readFileSync(parts[3][0])).seconds - 0.12) < 0.02, "closing breath part");
      const first = parseWav(fs.readFileSync(parts[0][0]));
      assert.ok(first.seconds > 0.3);
      const pcm = fs.readFileSync(parts[0][0]).subarray(first.dataOffset);
      let lead = 0;
      while (lead < pcm.length / 2 && Math.abs(pcm.readInt16LE(lead * 2)) < 300) lead++;
      assert.ok(lead / 24000 < 0.1, `leading silence ${lead / 24000}s should be trimmed to ~0.08s`);
      // 2) cancel mid-generation frees the daemon quickly for the next request
      const long = Array(20).fill("Some words here").join(". ");
      const a = d.request(
        { text: long, sid: 0, speed: 1, out: path.join(out, "b.wav"), stream: true, priority: 1 },
        () => {}
      );
      const b = d.request(
        { text: "Quick", sid: 0, speed: 1, out: path.join(out, "c.wav"), stream: true, priority: 1 },
        () => {}
      );
      await sleep(200);
      const t0 = Date.now();
      a.cancel();
      await assert.rejects(a.promise, /cancelled/);
      await b.promise;
      assert.ok(Date.now() - t0 < 1500, "next request should not wait for the cancelled one");
      // 3) urgent requests are served before queued background ones
      const order = [];
      let bg1Started = false;
      const bg1 = d
        .request(
          {
            text: "Background one. Background one b. Background one c",
            sid: 0,
            speed: 1,
            out: path.join(out, "d.wav"),
            stream: true,
          },
          () => (bg1Started = true)
        )
        .promise.then(() => order.push("bg1"));
      await until(() => bg1Started, 5000); // bg1 is generating; now queue a background and an urgent request
      const bg2 = d
        .request({ text: "Background two", sid: 0, speed: 1, out: path.join(out, "e.wav"), stream: true }, () => {})
        .promise.then(() => order.push("bg2"));
      const ug = d
        .request(
          { text: "Urgent", sid: 0, speed: 1, out: path.join(out, "f.wav"), stream: true, priority: 1 },
          () => {}
        )
        .promise.then(() => order.push("urgent"));
      await Promise.all([bg1, bg2, ug]);
      assert.deepEqual(order, ["bg1", "urgent", "bg2"]); // urgent jumps the queued background request
      assert.deepEqual(errors, []);
    } finally {
      d.dispose();
    }
  }
);

test(
  "MLX daemon: streaming, runaway cutoff, cancel, priority, non-stream trim",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const log = path.join(dir, "d.log");
    const errors = [];
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "qwen3_mlx_daemon.py"),
      { model_id: "fake" },
      (m) => errors.push(m),
      {
        readyTimeoutMs: 20000,
        env: { PYTHONPATH: dir },
        logFile: log,
      }
    );
    try {
      await d.ready;
      const out = tmpDir("cv-parts-");
      const parts = [];
      await d.request(
        {
          text: "one two three four five six seven eight",
          voice: "Ryan",
          language: "English",
          out: path.join(out, "a.wav"),
          stream: true,
          priority: 1,
        },
        (f, fin) => parts.push([f, fin])
      ).promise;
      assert.ok(parts.length >= 3, `parts ${parts.length}`);
      assert.equal(parts[parts.length - 1][1], true);
      const total = parts.reduce((s, [f]) => s + parseWav(fs.readFileSync(f)).seconds, 0);
      assert.ok(total > 1.9 && total < 2.4, `total ${total}s (2.0s minus lead-in, plus the 0.3s closing breath)`);
      // runaway: 3 words -> expected ~4.6s budget; the fake would produce 60s
      const rw = [];
      const t0 = Date.now();
      await d.request(
        {
          text: "RUNAWAY a b",
          voice: "Ryan",
          language: "English",
          out: path.join(out, "r.wav"),
          stream: true,
          priority: 1,
        },
        (f) => rw.push(f)
      ).promise;
      const rwSecs = rw.reduce((s, f) => s + parseWav(fs.readFileSync(f)).seconds, 0);
      assert.ok(rwSecs < 6, `runaway cut at ${rwSecs}s`);
      assert.ok(Date.now() - t0 < 5000);
      await until(() => fs.readFileSync(log, "utf8").includes('"runaway": true'), 2000);
      // cancel + priority
      const a = d.request(
        {
          text: Array(40).fill("w").join(" "),
          voice: "Ryan",
          language: "English",
          out: path.join(out, "b.wav"),
          stream: true,
        },
        () => {}
      );
      const b = d.request(
        { text: "x y", voice: "Ryan", language: "English", out: path.join(out, "c.wav"), stream: true, priority: 1 },
        () => {}
      );
      await sleep(150);
      a.cancel();
      await assert.rejects(a.promise, /cancelled/);
      await b.promise;
      // non-streaming path writes one trimmed file
      await d.request({
        text: "one two three",
        voice: "Ryan",
        language: "English",
        out: path.join(out, "n.wav"),
        priority: 1,
      }).promise;
      const n = parseWav(fs.readFileSync(path.join(out, "n.wav")));
      assert.ok(n.seconds > 0.75 && n.seconds < 1.0, `non-stream ${n.seconds}s`);
      assert.deepEqual(errors, []);
    } finally {
      d.dispose();
    }
  }
);

test("daemon that never becomes ready is killed and reported", async () => {
  const dir = tmpDir("cv-fake-");
  fs.writeFileSync(path.join(dir, "hang.py"), "import time\ntime.sleep(30)\n");
  const errors = [];
  const d = new PyTtsDaemon("python3", path.join(dir, "hang.py"), {}, (m) => errors.push(m), { readyTimeoutMs: 300 });
  await assert.rejects(d.ready, /did not become ready/);
  await until(() => !d.alive, 2000);
  assert.match(errors[0], /did not become ready/);
});

test("MLX daemon applies per-profile gain to clone output", { skip: !python && "no python with numpy" }, async () => {
  const dir = tmpDir("cv-fake-");
  fakeModules(dir);
  const out = tmpDir("cv-parts-");
  const peakOf = (f) => {
    const b = fs.readFileSync(f);
    const i = parseWav(b);
    const pcm = b.subarray(i.dataOffset);
    let peak = 0;
    for (let k = 0; k < pcm.length / 2; k++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(k * 2)));
    return peak / 32767;
  };
  const run = async (gain) => {
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "qwen3_mlx_daemon.py"),
      { model_id: "fake", clone: { ref_audio: "/x.wav", ref_text: "x", gain } },
      () => {},
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir } }
    );
    try {
      await d.ready;
      const f = path.join(out, `g${gain}.wav`);
      await d.request({ text: "one two three", language: "English", out: f, priority: 1 }).promise;
      return peakOf(f);
    } finally {
      d.dispose();
    }
  };
  const base = await run(1);
  const loud = await run(1.5);
  const quiet = await run(0.5);
  assert.ok(Math.abs(base - 0.3) < 0.02, `base peak ${base}`);
  assert.ok(loud > base * 1.3 && loud <= 1, `loud peak ${loud}`);
  assert.ok(Math.abs(quiet - 0.15) < 0.02, `quiet peak ${quiet}`);
});

test(
  "a per-request reference overrides the daemon's own: another cloned voice is audible without a reload",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const out = tmpDir("cv-parts-");
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "qwen3_mlx_daemon.py"),
      { model_id: "fake", clone: { ref_audio: "/a.wav", ref_text: "aaaa" } },
      (m) => {
        throw new Error(m);
      },
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir } }
    );
    try {
      await d.ready;
      const toneOf = async (name, extra) => {
        const f = path.join(out, `${name}.wav`);
        await d.request({ text: "one two three", language: "English", out: f, priority: 1, ...extra }).promise;
        const b = fs.readFileSync(f);
        const i = parseWav(b);
        const pcm = b.subarray(i.dataOffset);
        let crossings = 0;
        for (let k = 1; k < pcm.length / 2; k++)
          if (pcm.readInt16LE(k * 2) >= 0 !== pcm.readInt16LE((k - 1) * 2) >= 0) crossings++;
        return crossings / 2 / i.seconds;
      };
      const own = await toneOf("own", {});
      const other = await toneOf("other", { ref_audio: "/b.wav", ref_text: "bbbbbbb" });
      // The fake's pitch follows the reference (380Hz vs 500Hz before edge
      // trimming, which lowers both measured rates by the same factor).
      assert.ok(
        other / own > 1.25 && other / own < 1.4,
        `own ${Math.round(own)}Hz, per-request ${Math.round(other)}Hz`
      );
      // Per-request gain applies too (used when auditioning a louder profile).
      const peak = (f) => {
        const b = fs.readFileSync(f);
        const i = parseWav(b);
        const pcm = b.subarray(i.dataOffset);
        let p = 0;
        for (let k = 0; k < pcm.length / 2; k++) p = Math.max(p, Math.abs(pcm.readInt16LE(k * 2)));
        return p / 32767;
      };
      const loud = path.join(out, "loud.wav");
      await d.request({ text: "one two three", language: "English", out: loud, priority: 1, gain: 1.5 }).promise;
      assert.ok(peak(loud) > 0.38, `per-request gain: peak ${peak(loud)}`);
    } finally {
      d.dispose();
    }
  }
);

test(
  "the streaming vocoder is primed with the reference once, and every stream starts from that",
  { skip: !python && "no python with numpy" },
  async () => {
    // Streaming decoded the first chunk with a cold vocoder: on the same codes
    // the cold decode opened at 190-200 Hz and slid down to the speaker's
    // 85-115 Hz over half a second, which is the high, robotic start that
    // settles. The daemon now decodes the reference codes into the decoder's
    // state once per reference, keeps that state, and puts it back before each
    // stream; the log says so exactly once for two streams.
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const out = tmpDir("cv-parts-");
    const ref = writeWav(path.join(out, "ref.wav"), 4); // 4 s: 50 codec tokens in the fake
    const log = path.join(out, "daemon.log");
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "qwen3_mlx_daemon.py"),
      { model_id: "fake", clone: { ref_audio: ref, ref_text: "the reference words", gain: 1 } },
      () => {},
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir }, logFile: log }
    );
    try {
      await d.ready;
      for (const n of [1, 2]) {
        const parts = [];
        await d.request(
          {
            text: "one two three four five six",
            language: "English",
            out: path.join(out, `s${n}.wav`),
            stream: true,
            priority: 1,
          },
          (p) => parts.push(p)
        ).promise;
        assert.ok(parts.length >= 2, `stream ${n} still arrives in parts (${parts.length})`);
      }
    } finally {
      d.dispose();
    }
    const text = fs.readFileSync(log, "utf8");
    assert.match(
      text,
      /"icl": "direct", "repetition_penalty": 1.1\b/,
      "clones go through the clone path with the daemon's own penalty"
    );
    const primed = text.split("\n").filter((l) => l.includes('"primed"'));
    assert.equal(primed.length, 1, `primed exactly once for one reference, got ${primed.length}`);
    assert.match(primed[0], /"tokens": 50\b/, "primed with the whole reference, not a slice of it");
    assert.ok(!text.includes("prime_error") && !text.includes("prime_skipped"), "priming did not fall back");
  }
);

test(
  "pauses follow the punctuation and honour the pause scale",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const out = tmpDir("cv-parts-");
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "kokoro_daemon.py"),
      { model: "m", voices: "v", tokens: "t", data_dir: "d" },
      (m) => {
        throw new Error(m);
      },
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir } }
    );
    const tailOf = (f) => {
      const b = fs.readFileSync(f);
      const i = parseWav(b);
      const pcm = b.subarray(i.dataOffset);
      let n = pcm.length / 2,
        t = 0;
      while (t < n && Math.abs(pcm.readInt16LE((n - 1 - t) * 2)) < 300) t++;
      return t / i.sampleRate;
    };
    const firstTail = async (text, extra) => {
      const parts = [];
      await d.request(
        {
          text,
          sid: 0,
          speed: 1,
          out: path.join(out, `${parts.length}-${text.length}.wav`),
          stream: true,
          priority: 1,
          ...extra,
        },
        (f) => parts.push(f)
      ).promise;
      return tailOf(parts[0]);
    };
    try {
      await d.ready;
      const full = await firstTail("A finished thought. Another sentence follows here");
      const clause = await firstTail("A leading clause: the rest of it follows here");
      assert.ok(
        full > clause + 0.08,
        `full stop ${full.toFixed(2)}s should pause longer than a colon ${clause.toFixed(2)}s`
      );
      // The scale multiplies both.
      const wide = await firstTail("A finished thought. Another sentence follows here", { pause_scale: 2 });
      assert.ok(wide > full * 1.6, `scaled pause ${wide.toFixed(2)}s vs ${full.toFixed(2)}s`);
      const tight = await firstTail("A finished thought. Another sentence follows here", { pause_scale: 0 });
      assert.ok(tight < 0.12, `pause_scale 0 should run sentences together, got ${tight.toFixed(2)}s`);
      // The variation is stable: the same sentence pauses the same length twice.
      const again = await firstTail("A finished thought. Another sentence follows here");
      assert.ok(Math.abs(again - full) < 0.01, "the same text must sound the same");
    } finally {
      d.dispose();
    }
  }
);

test(
  "Chatterbox MLX daemon: whole-file output, runaway cutoff, cancel, priority, per-request reference",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const log = path.join(dir, "cb.log");
    const errors = [];
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "chatterbox_mlx_daemon.py"),
      { model_id: "fake", ref_audio: "/a.wav" },
      (m) => errors.push(m),
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir }, logFile: log }
    );
    try {
      await d.ready;
      const out = tmpDir("cv-cb-");
      // Chatterbox cannot stream: one finished file per request, flagged final.
      const parts = [];
      const f = path.join(out, "a.wav");
      await d.request({ text: "one two three four five", language: "ar", out: f, priority: 1 }, (p, fin) =>
        parts.push([p, fin])
      ).promise;
      assert.deepEqual(parts, [[f, true]]);
      assert.ok(parseWav(fs.readFileSync(f)).seconds > 0.5, "wrote audio");

      // Runaway guard: 3 words budget ~4.6s, the fake would produce 60s.
      const r = path.join(out, "r.wav");
      await d.request({ text: "RUNAWAY a b", language: "en", out: r, priority: 1 }).promise;
      const rwSecs = parseWav(fs.readFileSync(r)).seconds;
      assert.ok(rwSecs < 6, `runaway cut at ${rwSecs}s`);
      await until(() => fs.readFileSync(log, "utf8").includes('"runaway": true'), 2000);

      // A queued request can be cancelled; an urgent one still lands.
      const slow = d.request({ text: Array(40).fill("w").join(" "), language: "en", out: path.join(out, "b.wav") });
      const urgent = d.request({ text: "x y", language: "en", out: path.join(out, "c.wav"), priority: 1 });
      slow.cancel();
      await assert.rejects(slow.promise, /cancelled/);
      await urgent.promise;

      // A per-request reference wins over the daemon's own, so auditioning
      // another cloned voice needs no reload (the fake's pitch follows it).
      const pitchOf = async (name, extra) => {
        const p = path.join(out, `${name}.wav`);
        await d.request({ text: "one two three", language: "en", out: p, priority: 1, ...extra }).promise;
        const b = fs.readFileSync(p);
        const i = parseWav(b);
        const pcm = b.subarray(i.dataOffset);
        let crossings = 0;
        for (let k = 1; k < pcm.length / 2; k++)
          if (pcm.readInt16LE(k * 2) >= 0 !== pcm.readInt16LE((k - 1) * 2) >= 0) crossings++;
        return crossings / 2 / i.seconds;
      };
      const own = await pitchOf("own", {});
      const other = await pitchOf("other", { ref_audio: "/b.wav" });
      assert.ok(Math.abs(other - own) > 20, `own ${Math.round(own)}Hz vs per-request ${Math.round(other)}Hz`);
      assert.deepEqual(errors, []);
    } finally {
      d.dispose();
    }
  }
);

test(
  "MLX daemons budget dense scripts by character: Chinese is not truncated to the floor",
  { skip: !python && "no python with numpy" },
  async () => {
    // Chinese and Japanese are written without spaces. Budgeting by whitespace
    // words scored a whole sentence as one word, so max_tokens and the runaway
    // cutoff clipped every CJK chunk to a few seconds of speech.
    const zh = "上个月我们的频道达到了二十亿次观看这是一个新的里程碑我们都非常高兴今天继续努力";
    for (const script of ["chatterbox_mlx_daemon.py", "qwen3_mlx_daemon.py"]) {
      const dir = tmpDir("cv-fake-");
      fakeModules(dir);
      const log = path.join(dir, "d.log");
      const out = tmpDir("cv-zh-");
      const errors = [];
      const cfg = script.startsWith("chatterbox")
        ? { model_id: "fake", ref_audio: "/a.wav" }
        : { model_id: "fake", clone: { ref_audio: "/a.wav", ref_text: "aaaa" } };
      const d = new PyTtsDaemon(python, path.join(ROOT, "assets", script), cfg, (m) => errors.push(m), {
        readyTimeoutMs: 20000,
        env: { PYTHONPATH: dir },
        logFile: log,
      });
      try {
        await d.ready;
        const f = path.join(out, "zh.wav");
        await d.request({ text: zh, language: script.startsWith("chatterbox") ? "zh" : "Chinese", out: f, priority: 1 })
          .promise;
        const secs = parseWav(fs.readFileSync(f)).seconds;
        // The fake speaks this in ~4.2s; the old word-count budget floored the
        // cutoff at 3.5s and logged a spurious runaway.
        assert.ok(secs > 3.9, `${script}: Chinese clipped to ${secs.toFixed(2)}s`);
        assert.ok(!fs.readFileSync(log, "utf8").includes('"runaway": true'), `${script}: spurious runaway on Chinese`);
        assert.deepEqual(errors, []);
      } finally {
        d.dispose();
      }
    }
  }
);

test(
  "Chatterbox MLX daemon re-reads a reference rewritten in place",
  { skip: !python && "no python with numpy" },
  async () => {
    // Refining, re-recording or re-designing a voice rewrites ref.wav at the
    // same path. A path-keyed decode cache would keep speaking the old voice
    // for the rest of the session, so the refinement would be inaudible.
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const out = tmpDir("cv-ref-");
    const ref = path.join(out, "ref.wav");
    const writeRef = (freq) => writeWav(ref, 0.4, { freq });
    writeRef(300);
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "chatterbox_mlx_daemon.py"),
      { model_id: "fake", ref_audio: ref },
      (m) => {
        throw new Error(m);
      },
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir } }
    );
    try {
      await d.ready;
      const pitchOf = async (name) => {
        const f = path.join(out, `${name}.wav`);
        await d.request({ text: "one two three", language: "en", out: f, priority: 1, ref_audio: ref }).promise;
        const b = fs.readFileSync(f);
        const i = parseWav(b);
        const pcm = b.subarray(i.dataOffset);
        let crossings = 0;
        for (let k = 1; k < pcm.length / 2; k++)
          if (pcm.readInt16LE(k * 2) >= 0 !== pcm.readInt16LE((k - 1) * 2) >= 0) crossings++;
        return crossings / 2 / i.seconds;
      };
      const before = await pitchOf("before");
      await sleep(20);
      writeRef(900); // same path, different audio: the voice was refined
      const after = await pitchOf("after");
      assert.ok(
        Math.abs(after - before) > 100,
        `refined reference ignored: ${Math.round(before)}Hz then ${Math.round(after)}Hz`
      );
    } finally {
      d.dispose();
    }
  }
);

test(
  "Chatterbox torch daemon: whole-file output, runaway cutoff, CJK budget, explicit reference",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const log = path.join(dir, "cbt.log");
    const errors = [];
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "chatterbox_daemon.py"),
      { ref_audio: "/a.wav" },
      (m) => errors.push(m),
      {
        readyTimeoutMs: 20000,
        env: { PYTHONPATH: dir },
        logFile: log,
      }
    );
    const pitchOf = (f) => {
      const b = fs.readFileSync(f);
      const i = parseWav(b);
      const pcm = b.subarray(i.dataOffset);
      let crossings = 0;
      for (let k = 1; k < pcm.length / 2; k++)
        if (pcm.readInt16LE(k * 2) >= 0 !== pcm.readInt16LE((k - 1) * 2) >= 0) crossings++;
      return crossings / 2 / i.seconds;
    };
    try {
      await d.ready;
      const out = tmpDir("cv-cbt-");
      const parts = [];
      const f = path.join(out, "a.wav");
      await d.request(
        { text: "one two three four five", language: "ar", out: f, priority: 1, ref_audio: "/a.wav" },
        (p, fin) => parts.push([p, fin])
      ).promise;
      assert.deepEqual(parts, [[f, true]]);
      assert.ok(parseWav(fs.readFileSync(f)).seconds > 0.5, "wrote audio");
      // Runaway guard, newly shared with the MLX daemon.
      const r = path.join(out, "r.wav");
      await d.request({ text: "RUNAWAY a b", language: "en", out: r, priority: 1, ref_audio: "/a.wav" }).promise;
      assert.ok(parseWav(fs.readFileSync(r)).seconds < 6, "runaway cut");
      await until(() => fs.readFileSync(log, "utf8").includes('"runaway": true'), 2000);
      // Dense scripts are budgeted per character, so Chinese is not clipped.
      const z = path.join(out, "zh.wav");
      await d.request({
        text: "上个月我们的频道达到了二十亿次观看这是一个新的里程碑我们都非常高兴今天继续努力",
        language: "zh",
        out: z,
        priority: 1,
        ref_audio: "/a.wav",
      }).promise;
      assert.ok(
        parseWav(fs.readFileSync(z)).seconds > 3.9,
        `Chinese clipped to ${parseWav(fs.readFileSync(z)).seconds.toFixed(2)}s`
      );
      // An explicit null reference means the built-in speaker, not the one the
      // daemon started with: the fake's pitch tells them apart.
      const own = path.join(out, "own.wav");
      const none = path.join(out, "none.wav");
      await d.request({ text: "one two three", language: "en", out: own, priority: 1, ref_audio: "/a.wav" }).promise;
      await d.request({ text: "one two three", language: "en", out: none, priority: 1, ref_audio: null }).promise;
      assert.ok(
        Math.abs(pitchOf(own) - pitchOf(none)) > 20,
        `null reference still used the startup one: ${Math.round(pitchOf(own))}Hz vs ${Math.round(pitchOf(none))}Hz`
      );
      // Conditioning is prepared once per reference, not per sentence: the fake
      // encodes its prepare count in the duration of a "PREPARED" utterance.
      const p1 = path.join(out, "p1.wav");
      const p2 = path.join(out, "p2.wav");
      await d.request({ text: "PREPARED one", language: "en", out: p1, priority: 1, ref_audio: "/a.wav" }).promise;
      await d.request({ text: "PREPARED two", language: "en", out: p2, priority: 1, ref_audio: "/a.wav" }).promise;
      assert.ok(
        Math.abs(parseWav(fs.readFileSync(p1)).seconds - parseWav(fs.readFileSync(p2)).seconds) < 0.02,
        "the same reference was re-prepared between sentences"
      );
      assert.deepEqual(errors, []);
    } finally {
      d.dispose();
    }
  }
);

test(
  "Chatterbox MLX daemon re-voices existing speech: the length is the source's, the voice is the reference's",
  { skip: !python && "no python with numpy" },
  async () => {
    const dir = tmpDir("cv-fake-");
    fakeModules(dir);
    const out = tmpDir("cv-vc-");
    const log = path.join(dir, "vc.log");
    const src = writeWav(path.join(out, "piper.wav"), 2.0, { rate: 16000, freq: 150 }); // "Piper" said something for 2s
    const refA = writeWav(path.join(out, "a.wav"), 1.0, { freq: 300 });
    const refB = writeWav(path.join(out, "b.wav"), 1.0, { freq: 900 });
    const d = new PyTtsDaemon(
      python,
      path.join(ROOT, "assets", "chatterbox_mlx_daemon.py"),
      { model_id: "fake", ref_audio: refA },
      (m) => {
        throw new Error(m);
      },
      { readyTimeoutMs: 20000, env: { PYTHONPATH: dir }, logFile: log }
    );
    const pitchOf = (f) => {
      const b = fs.readFileSync(f);
      const i = parseWav(b);
      const pcm = b.subarray(i.dataOffset);
      let c = 0;
      for (let k = 1; k < pcm.length / 2; k++)
        if (pcm.readInt16LE(k * 2) >= 0 !== pcm.readInt16LE((k - 1) * 2) >= 0) c++;
      return c / 2 / i.seconds;
    };
    try {
      await d.ready;
      const a = path.join(out, "in-a.wav");
      const b = path.join(out, "in-b.wav");
      await d.request({ convert: src, out: a, priority: 1, ref_audio: refA }).promise;
      await d.request({ convert: src, out: b, priority: 1, ref_audio: refB }).promise;
      for (const f of [a, b])
        assert.ok(
          Math.abs(parseWav(fs.readFileSync(f)).seconds - 2.0) < 0.35,
          `length follows the source: ${parseWav(fs.readFileSync(f)).seconds}s`
        );
      assert.ok(
        Math.abs(pitchOf(a) - pitchOf(b)) > 100,
        `the reference decides the voice: ${Math.round(pitchOf(a))}Hz vs ${Math.round(pitchOf(b))}Hz`
      );
      await until(() => fs.readFileSync(log, "utf8").includes('"convert": true'), 2000);
      await assert.rejects(
        d.request({ convert: src, out: path.join(out, "none.wav"), priority: 1, ref_audio: null }).promise,
        /reference/
      );
    } finally {
      d.dispose();
    }
  }
);

/** The Chatterbox MLX daemon with the fakes, cfg as given. */
function chatterboxDaemon(cfg, extraEnv = {}) {
  const dir = tmpDir("cv-fake-");
  fakeModules(dir);
  const errors = [];
  const log = path.join(dir, "daemon.log");
  const d = new PyTtsDaemon(python, path.join(ROOT, "assets", "chatterbox_mlx_daemon.py"), cfg, (m) => errors.push(m), {
    readyTimeoutMs: 20000,
    env: { PYTHONPATH: dir, ...extraEnv },
    logFile: log,
  });
  // The daemon falls back to the whole chunk when streaming raises, which a
  // protocol test would otherwise mistake for a wrong part count.
  const stderr = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return { d, errors, stderr };
}

test(
  "chatterbox streams: parts arrive as the tokens are generated, exactly one is final, then ok",
  { skip: !python && "no python with numpy" },
  async () => {
    const out = tmpDir("cv-out-");
    const ref = writeWav(path.join(out, "ref.wav"), 1.0);
    const { d, stderr } = chatterboxDaemon({ ref_audio: ref });
    try {
      await d.ready;
      const parts = [];
      const msg = await d.request(
        {
          text: "Twelve words of text here, enough for the fake to produce two parts easily.",
          language: "en",
          ref_audio: ref,
          out: path.join(out, "s.wav"),
          stream: true,
          priority: 1,
        },
        (file, final) => parts.push({ file, final, seconds: parseWav(fs.readFileSync(file)).seconds })
      ).promise;
      assert.equal(msg.ok, true, JSON.stringify(msg));
      assert.ok(!/stream_fallback|stream_error/.test(stderr()), `streaming fell back: ${stderr().slice(-600)}`);
      // 130 fake tokens: a part at 50 (the first word), then the final one.
      assert.equal(parts.length, 2, JSON.stringify(parts));
      assert.deepEqual(
        parts.map((p) => p.final),
        [false, true]
      );
      assert.ok(
        parts[0].seconds > 1.2 && parts[0].seconds < 2.2,
        `first part ${parts[0].seconds}s: 50 tokens minus lookahead and crossfade`
      );
      assert.ok(
        parts.every((p) => p.file.startsWith(path.join(out, "s.p"))),
        "parts share the request's prefix"
      );
      // The accounting: the fake makes exactly 960 samples per token, so the
      // joined stream must be the whole utterance once, not with a segment
      // repeated or dropped at a seam (only the 30 ms blend overlaps).
      const total = parts.reduce((n, p) => n + p.seconds, 0);
      const whole = 130 / 25;
      assert.ok(Math.abs(total - whole) < 0.2, `streamed ${total.toFixed(2)}s of a ${whole}s utterance`);
      // Continuity at the seam: the fake vocoder is one unbroken sine, so a
      // wrong offset in the accounting shows up as a phase jump where the
      // parts meet. A real seam blends two noise draws; the fake has none.
      // The daemon writes canonical 44-byte-header WAVs, so the PCM follows directly.
      const pcm = parts.map((p) => {
        const b = fs.readFileSync(p.file);
        return new Int16Array(b.buffer, b.byteOffset + 44, (b.length - 44) / 2);
      });
      const jump = Math.abs(pcm[1][0] - pcm[0][pcm[0].length - 1]) / 32768;
      assert.ok(jump < 0.05, `discontinuity at the seam: ${jump.toFixed(3)}`);
      assert.ok(
        typeof msg.gen_s === "number" && typeof msg.audio_s === "number",
        "the extension learns speed from the reply"
      );
    } finally {
      d.dispose();
    }
  }
);

test(
  "chatterbox streaming stops at the next token when cancelled, and removes what it emitted",
  { skip: !python && "no python with numpy" },
  async () => {
    const out = tmpDir("cv-out-");
    const ref = writeWav(path.join(out, "ref.wav"), 1.0);
    // Slow enough per token for the cancel to land mid-generation.
    const { d } = chatterboxDaemon({ ref_audio: ref }, { STREAM_TOKENS_FAKE: "100000", STREAM_SLOW: "1" });
    try {
      await d.ready;
      let first;
      const r = d.request(
        {
          text: "A request that would otherwise generate forever.",
          language: "en",
          ref_audio: ref,
          out: path.join(out, "c.wav"),
          stream: true,
          priority: 1,
        },
        (file) => {
          first = first ?? file;
          r.cancel();
        }
      );
      await assert.rejects(r.promise, /cancelled/);
      await sleep(200);
      assert.ok(first, "the first part had been emitted before the cancel");
      assert.ok(!fs.existsSync(first), "the emitted part is removed on cancel");
    } finally {
      d.dispose();
    }
  }
);

test(
  "chatterbox streaming falls back to the whole chunk when the model's internals do not fit",
  { skip: !python && "no python with numpy" },
  async () => {
    // An mlx-audio upgrade that moves things must cost streaming, not speech.
    const out = tmpDir("cv-out-");
    const ref = writeWav(path.join(out, "ref.wav"), 1.0);
    const { d } = chatterboxDaemon({ ref_audio: ref }, { STREAM_BREAK: "1" });
    try {
      await d.ready;
      const parts = [];
      const msg = await d.request(
        {
          text: "Still spoken, all at once.",
          language: "en",
          ref_audio: ref,
          out: path.join(out, "f.wav"),
          stream: true,
          priority: 1,
        },
        (file, final) => parts.push({ file, final })
      ).promise;
      assert.equal(msg.ok, true, JSON.stringify(msg));
      assert.equal(parts.length, 1, "one whole part");
      assert.equal(parts[0].final, true);
      assert.equal(parts[0].file, path.join(out, "f.wav"));
    } finally {
      d.dispose();
    }
  }
);
