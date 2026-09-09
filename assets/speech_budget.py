# How long a piece of text takes to say, for the Python speech daemons.
#
# Every generator here needs a token budget: a cap that stops a model which
# never emits end-of-speech from babbling for minutes. The budget has to come
# from the text, and the obvious way to measure text is to count words.
#
# That breaks on Chinese, Japanese and Korean, which are written without
# spaces: a whole paragraph counts as one word, the budget collapses to its
# floor, and the model is cut off after a second or two of speech. This module
# exists because that bug was fixed three times in three daemons and still
# survived in a fourth, where designing a Chinese or Japanese voice produced
# under four seconds of audio and the flow reported that the model "produced
# almost no speech".
#
# Dense-script characters are counted directly instead, at roughly two per
# word, which is about the rate they are read at.
_DENSE_RANGES = (
    (0x3040, 0x30FF),  # kana
    (0x3400, 0x4DBF),  # CJK extension A
    (0x4E00, 0x9FFF),  # CJK unified
    (0xAC00, 0xD7AF),  # hangul syllables
    (0xF900, 0xFAFF),  # CJK compatibility
)

WORDS_PER_SECOND = 2.5
DENSE_CHARS_PER_WORD = 2.0


def is_dense(ch):
    """Is this a character of a script written without spaces?"""
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in _DENSE_RANGES)


def speech_units(text):
    """Words, counting dense-script characters as fractions of one."""
    t = str(text)
    dense = sum(1 for c in t if is_dense(c))
    # A token written entirely in a dense script is counted by character
    # rather than as a single word.
    words = sum(1 for w in t.split() if w and not all(is_dense(c) for c in w))
    return max(1, words + dense / DENSE_CHARS_PER_WORD)


def expected_seconds(text, overhead=3.0, slack=1.3):
    """A generous estimate of how long the text takes to say.

    Generous on purpose: it is a runaway cutoff, not a prediction, and cutting
    real speech short is far worse than letting a babble run a little longer.
    """
    return speech_units(text) / WORDS_PER_SECOND * slack + overhead
