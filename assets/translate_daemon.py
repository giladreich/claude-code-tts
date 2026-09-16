# Offline translation daemon for the Claude Code TTS VSCode extension.
#
# Uses Argos Translate (OpenNMT models that run locally); nothing is sent to a
# service. Stdio JSON protocol, one object per line:
#   {"id": 1, "text": "...", "from": "en", "to": "de"}  -> {"id": 1, "ok": true, "text": "..."}
#   {"id": 2, "op": "packages"}                          -> {"id": 2, "ok": true, "pairs": ["en>de", ...]}
#   {"id": 3, "op": "locate", "from": "en", "to": "de"} -> {"id": 3, "ok": true, "url": "...", "name": "..."}
#   {"id": 4, "op": "install", "from": "en", "to": "de", "path": "/tmp/x.argosmodel"} -> {"id": 4, "ok": true}
# The extension fetches the model file itself (through the editor's proxy, with
# progress shown) and hands the daemon the path; without a path the daemon
# downloads it, as argos would.
# Translations are cached per pair; the model stays loaded between requests.
import json
import sys

import argostranslate.package
import argostranslate.translate

_translations = {}


def pairs():
    langs = argostranslate.translate.get_installed_languages()
    out = []
    for a in langs:
        for b in langs:
            if a.code != b.code and a.get_translation(b) is not None:
                out.append(f"{a.code}>{b.code}")
    return out


def _lookup(src, dst):
    langs = {l.code: l for l in argostranslate.translate.get_installed_languages()}
    a, b = langs.get(src), langs.get(dst)
    return a.get_translation(b) if a and b else None


def translation_for(src, dst):
    key = f"{src}>{dst}"
    t = _translations.get(key)
    if t is None:
        t = _lookup(src, dst)
        if t is None:
            # Argos memoises the installed languages for the life of the process
            # and only its own install() clears that. A model installed by
            # another process (a second editor window running its own daemon,
            # or argospm) is invisible until the memo is dropped, so a miss
            # re-reads the package folder once before it is reported. Cheap:
            # a directory scan, no model load. A miss is never cached, so the
            # next request after an install anywhere finds the model.
            argostranslate.translate.get_installed_languages.cache_clear()
            t = _lookup(src, dst)
        if t is not None:
            _translations[key] = t
    return t


def published(src, dst):
    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()
    match = next((p for p in available if p.from_code == src and p.to_code == dst), None)
    if match is None:
        raise RuntimeError(f"no published model for {src} to {dst}")
    return match


def locate(src, dst):
    match = published(src, dst)
    links = list(getattr(match, "links", None) or [])
    if not links:
        raise RuntimeError(f"the index names no download for {src} to {dst}")
    return {"url": links[0], "name": f"translate-{src}_{dst}.argosmodel"}


def install(src, dst, path=None):
    argostranslate.package.install_from_path(path or published(src, dst).download())
    _translations.clear()


print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid = req.get("id")
    try:
        op = req.get("op", "translate")
        if op == "packages":
            print(json.dumps({"id": rid, "ok": True, "pairs": pairs()}), flush=True)
        elif op == "locate":
            print(json.dumps({"id": rid, "ok": True, **locate(req["from"], req["to"])}), flush=True)
        elif op == "install":
            install(req["from"], req["to"], req.get("path"))
            print(json.dumps({"id": rid, "ok": True, "pairs": pairs()}), flush=True)
        else:
            t = translation_for(req["from"], req["to"])
            if t is None:
                raise RuntimeError(f"no model installed for {req['from']} to {req['to']}")
            print(json.dumps({"id": rid, "ok": True, "text": t.translate(req["text"])}), flush=True)
    except Exception as e:  # keep serving after a bad request
        print(json.dumps({"id": rid, "ok": False, "error": str(e)}), flush=True)
