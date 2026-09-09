# Prepare Hebrew and Arabic text for the neural engines, in the extension's
# Python daemons.
#
# Hebrew and Arabic are written without vowels. A reader supplies them from
# context; a TTS model cannot, so it guesses, and the result is words that are
# not the words that were written. Measured on this machine with Chatterbox
# Multilingual v3 speaking a cloned voice, transcribed back with
# whisper-large-v3-turbo: unvocalized Hebrew scores CER 0.294 / WER 0.683,
# and the same sentences through this module score CER 0.076 / WER 0.194
# (24 generations, no collapses). The model was never the problem; the
# missing vowels were.
#
# Two steps, both cheap next to synthesis (~1.4x realtime):
#   1. Numbers become words. "118" is read as a quantity rather than guessed
#      at digit by digit ("1028" was what came back before this).
#   2. Hebrew gets niqqud from Nakdimon (MIT, Elazar Gershuni), ~47 ms per
#      sentence with the session kept open.
#
# Arabic is left as written: it scores CER 0.051 / WER 0.12 unvocalized here,
# which is usable, and the diacritizer that would improve it (libtashkeel,
# MIT) has no packaged Python distribution of its own. Numbers are still
# expanded, which is where most of its errors were.
#
# Everything degrades to "return the text unchanged": a missing package must
# cost pronunciation, never speech.
import re
import sys

_LOGGED = set()


def _log_once(key, message):
    if key not in _LOGGED:
        _LOGGED.add(key)
        print(f'{{"diacritize": "{message}"}}', file=sys.stderr, flush=True)


# A number that stands on its own. The guards keep identifiers and versions
# intact: nothing glued to a word character ("mp3", "v2", "speech.ts"), to a
# path or time separator ("speech.ts:42") or continuing into another dotted
# number ("1.32.2") is touched, while "118", "3.5" and a sentence-final "1."
# are expanded.
_NUMBER = re.compile(r"(?<![\w./:])(\d{1,9}(?:\.\d+)?)(?!\w|\.\d)")
_NIQQUD = re.compile("[֑-ׇ]")
_HEBREW_LETTER = re.compile("[א-ת]")
_ARABIC_LETTER = re.compile("[ؠ-ي]")


def _numbers_to_words(text, language):
    try:
        from num2words import num2words
    except ImportError:
        _log_once("num2words", "num2words is not installed: numbers stay as digits")
        return text

    def replace(match):
        token = match.group(1)
        try:
            value = float(token) if "." in token else int(token)
            return num2words(value, lang=language)
        except (ValueError, NotImplementedError, OverflowError):
            return token  # an unsupported language or a number it cannot say

    return _NUMBER.sub(replace, text)


_nakdimon = {}


def _add_niqqud(text):
    """Hebrew with vowel points. Unchanged if Nakdimon is not installed."""
    if _NIQQUD.search(text):
        return text  # already pointed (a user's own text, or a second pass)
    try:
        if "session" not in _nakdimon:
            import nakdimon
            from nakdimon.predict import load_cached_model

            _nakdimon["session"] = load_cached_model(nakdimon.MAIN_MODEL)
        from nakdimon.predict import predict

        # The package pads every input to 10000 characters by default, which
        # costs six seconds a sentence; bounded to this sentence it costs 47 ms
        # and returns the same text.
        return predict(text, _nakdimon["session"], maxlen=max(64, len(text) + 8))
    except Exception as e:  # missing package, bad model file, anything
        _log_once("nakdimon", f"no Hebrew diacritizer ({type(e).__name__}): Hebrew will be guessed")
        return text


def prepare(text, language):
    """Text an engine can pronounce, for the languages that need help."""
    code = str(language or "").lower()[:2]
    if code == "he" and _HEBREW_LETTER.search(text):
        return _add_niqqud(_numbers_to_words(text, "he"))
    if code == "ar" and _ARABIC_LETTER.search(text):
        return _numbers_to_words(text, "ar")
    return text
