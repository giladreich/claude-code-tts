# Responsible use of voice cloning

Claude Code TTS can build a synthetic voice from a short recording. That is useful when the voice is **yours**, or belongs to someone who has agreed to it. It is also, like every voice cloning tool, open to misuse. This page states the line plainly.

## The rule

**Only clone a voice you own or have the speaker's informed, documented permission to clone.** "Informed" means the person knows their voice will be synthesized, for what purpose, and can withdraw. A public recording being downloadable is not permission.

## Never use it for

- **Impersonation**: making anyone appear to say something they did not say, including colleagues, family, public figures, or customer-service and support staff. A profile is not limited to the language it was recorded in: the two engines that speak profiles cover ten and twenty-three languages between them, so a cloned voice can be made to speak ones its owner never spoke.
- **Fraud and social engineering**: voice-based identity verification, payment approvals, "hi, it's me" calls to relatives or helpdesks, or anything that trades on a listener believing a specific person is speaking.
- **Harassment, defamation, or sexual content** involving a real person's voice.
- **Evading disclosure**: presenting synthetic speech as a genuine recording where it matters (journalism, evidence, political communication, advertising).

If you publish or share synthetic speech, say that it is synthetic.

## Legal context, briefly

This is a summary, not legal advice, and obligations depend on where you and the speaker are.

- **EU AI Act, Article 50**: deep fake audio must be disclosed as artificially generated or manipulated. Providers and deployers both carry duties.
- **GDPR**: a voice recording is personal data. Processing it needs a lawful basis, and using voice characteristics to *identify* a person makes it biometric data under Article 9, with a much narrower set of permitted grounds. Keep the reference recording only as long as you need it; deleting a profile in "My Voices" moves it to a local trash, and emptying that trash in "Storage and Cleanup" erases the recording.
- **Personality and publicity rights**: many jurisdictions (including US states with right-of-publicity statutes, and Germany's allgemeines Persönlichkeitsrecht) protect a person's voice independently of copyright.
- **Fraud statutes** apply to impersonation regardless of the tool used.

## What the extension does about it

- Before your first clone, from the microphone or from a file, a dialog states the rule and asks you to confirm you have the right to use that voice. It offers to open this page and asks again afterwards. It is shown once per installation and recorded only locally, and the page stays reachable from "My Voices" and from the message shown after an export.
- Every clone stays on your machine: references and profiles live in the extension's storage and are never uploaded. Deleting a profile moves it to a local trash you can restore from; emptying that trash in "Storage and Cleanup" erases the recording for good. See [PRIVACY.md](PRIVACY.md).
- Voice backups ("Back Up Voices to a File") contain the reference recording. Sharing one hands someone the ability to speak in that voice: do it only with the speaker's agreement, and only with people you trust to follow the same rules. The message shown after an export says so, and links here. "Import Voices from a File" installs such a recording on your machine without asking again: the same rule covers a voice someone sent you.
- Designed voices ("Design a Voice from a Description") are synthetic by construction and are not built from a real person's recording. Do not use a description to imitate a specific identifiable person.

Reports of misuse of this extension, or requests to remove a published voice, belong with the platform hosting the content; the extension's authors have no copy of anything you produce.
