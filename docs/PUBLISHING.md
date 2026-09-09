# Publishing

Releases come from a git tag. [.github/workflows/release.yml](../.github/workflows/release.yml)
builds the `.vsix`, attaches it to a GitHub release, and publishes it to the
Marketplace. Nothing is stored: GitHub mints a short-lived token for the run,
Microsoft Entra ID trades it for an Azure token, and `vsce` publishes with
that.

Set it up once, then a release is three commands.

## Release

1. Add the new section to [CHANGELOG.md](../CHANGELOG.md), headed `## [1.1.0]`
   (a date after it is fine, the brackets are optional). The workflow pulls the
   release notes out by that heading, and writes "See CHANGELOG.md." if it finds
   none; `test/unit/release.test.js` fails when the version in `package.json`
   has no section.
2. Set the same version in `package.json` and `package-lock.json`.
3. Commit, tag, push:

```sh
git tag 1.1.0
git push origin main --tags
```

Tags carry no `v` prefix: the tag is the version exactly as `package.json`
spells it, and the workflow refuses a tag that disagrees. The run publishes
to the Marketplace if `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are set, and to
Open VSX if `OVSX_PAT` is set; users get the update automatically within a few
minutes. Without them the run is still green: the `.vsix` is built and attached
to the GitHub release, and nothing is published.

Avoid `vsce publish minor` and friends: they bump `package.json` without
touching `package-lock.json` or the changelog. `test/unit/release.test.js`
catches the missing changelog section; nothing checks the lockfile, so set it
by hand.

## One-time setup

The Marketplace grants publishing rights to a **member of the publisher**,
and its member list understands exactly one kind of id: the identity's
**Azure DevOps profile id**. Not the client id, not an object id, and not a
resource id. An identity has a profile only once it has called Azure DevOps
at least once, which is why step 6 comes before step 7.

### 1. Create the publisher

1. Sign in at https://marketplace.visualstudio.com/manage.
2. Create a publisher. Its ID must match the `publisher` field in
   [package.json](../package.json), currently `giladreich`.

### 2. Create the identity that publishes

In the [Azure portal](https://portal.azure.com), *Microsoft Entra ID* ->
*App registrations* -> **New registration**:

- Name: `claude-code-tts`
- Accounts: single tenant
- Redirect URI: none

It costs nothing and needs no Azure subscription. From the **Overview** page
copy the **Application (client) ID** and the **Directory (tenant) ID**.

(With a subscription, a user-assigned managed identity works the same way and
every step below applies unchanged.)

### 3. Let this repository use it

On the app registration, *Certificates & secrets* -> **Federated credentials**
-> **Add credential** (on a managed identity: *Settings* -> *Federated
credentials*):

- Scenario: **GitHub Actions deploying Azure resources**
- Organization `giladreich`, Repository `claude-code-tts`
- Entity type: **Environment**, name `release`
- Credential name: `claude-code-tts-github-release`

Entity type matters. The workflow runs on a tag, so a branch credential never
matches; an environment credential matches whatever the tag is called.

### 4. Tell the workflow who to be

In GitHub, *Settings* -> *Secrets and variables* -> *Actions* ->
**Variables** (not secrets):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | the Application (client) ID from step 2 |
| `AZURE_TENANT_ID` | the Directory (tenant) ID from step 2 |

Variables rather than secrets on purpose: neither is a credential, and a
failed run stays readable.

### 5. Create the environment

*Settings* -> *Environments* -> **New environment** -> `release`. The name has
to match step 3. Adding yourself as a required reviewer makes every publish
ask for approval first.

### 6. Get the identity's Azure DevOps id

*Actions* -> *Release* -> **Run workflow**.

The run signs in with the federated credential and writes the id into its
summary:

```
Azure DevOps id of this identity: 8f4c1e2a-...
```

Copy it. The run then fails on `vsce verify-pat`, which is correct: the
identity is not a member of the publisher yet.

### 7. Add it to the publisher

At https://marketplace.visualstudio.com/manage, select `giladreich` ->
**Members** -> **Add**, paste the id from step 6, role **Contributor**.

Add the id of the identity that *publishes*, which is the app registration,
not your own. They are different ids, and adding yours makes `vsce publish`
work on your machine while the workflow keeps failing with the same message.
[Finding an id](#finding-an-identitys-azure-devops-id) has both.

### 8. Check it

*Actions* -> *Release* -> **Run workflow** again. Green means the next tag
publishes for real.

## Finding an identity's Azure DevOps id

The publisher's member list understands one kind of id: the **Azure DevOps
profile id** of an identity. It is not the Entra ID client id, not an object
id, and not an email address, and each identity has its own even when several
share an email. That is the usual confusion here: `myaccount@gmail.com` as
a personal Microsoft account (which created the publisher) and the same
address inside the Entra tenant (which `az login` gives you) are two
identities with two ids, and the app registration the workflow runs as is a
third.

An identity has a profile only once it has called Azure DevOps at least once.
Each of these calls creates it if it is missing, which is why asking for the
id is also what makes it exist.

**The identity you are signed in as, from the command line.** `499b84ac-...`
is Azure DevOps's own application ID in Entra ID, the same for everybody:

```sh
az login
az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv
```

**The identity you are signed in as, from a browser.** Open

```
https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1
```

while signed in as that account. The `id` in the JSON is the one to paste.
Signed in as the wrong account, this answers with the wrong id and nothing
says so, so check the `emailAddress` next to it.

**The identity the workflow runs as.** It has no browser and no password, so
it has to ask for itself: that is step 6 above, and the id lands in the run
summary.

**Who is a member already.** Answerable by any member, so it works once one
identity is in:

```sh
az rest -u "https://marketplace.visualstudio.com/_apis/securityroles/scopes/gallery.publisher/roleassignments/resources/giladreich?api-version=7.1-preview.1" \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --query "value[].[role.displayName, identity.id, identity.displayName]" -o tsv
```

```
Owner        dddcae09-...  Gilad Reich
Contributor  6682b34b-...  Gilad Reich
Contributor  eb648de2-...  9476a1c8-...\caa8a2a6-...
```

Read the middle column: the display name of a human identity is a name, and
two of those with the same name is normal, which is exactly why the id is
what the member list keys on. A service principal has no name to show, so it
appears as `<tenant id>\<its object id>`; that is the app registration from
step 2, and the id beside it is the one step 6 printed.

Before this call succeeds for anyone, it answers `Access Denied` naming the
id it is refusing, which is another way to read your own.

**Whether an identity may publish.** The question the release asks:

```sh
npx vsce verify-pat giladreich --azure-credential
```

## Publishing from your own machine

For the first release, or when CI is broken:

```sh
az login
npx vsce verify-pat giladreich --azure-credential
npm run package -- --out claude-code-tts-1.0.0.vsix
npx vsce publish --packagePath claude-code-tts-1.0.0.vsix --azure-credential
```

Through `npm run package`, never `vsce package` on its own: the Marketplace
copy of the README is written first (see below), and a bare `vsce` call
publishes an extension page with no README at all.

If `verify-pat` answers `The requested operation is not allowed`, the account
`az login` used is not the account the publisher knows. One email can be two
identities: signing in to the Marketplace directly is one, and signing in
through an Azure tenant is another. Print the id Azure DevOps gave this one
and add it as a member exactly as in step 7:

```sh
az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv
```

`499b84ac-1321-427f-aa17-267ca6975798` is Azure DevOps's own application ID
in Entra ID, the same for everybody.

## Open VSX

VSCodium, Cursor and other forks use https://open-vsx.org instead of
Microsoft's Marketplace. Create a namespace once, then add the token as the
`OVSX_PAT` repository secret and the release workflow publishes there too:

```sh
npx ovsx create-namespace giladreich -p <token>
```

## Before the first publish

- `npm run verify` is green: format check, lint, compile, tests. `vscode:prepublish`
  runs the same chain, so an unformatted tree, a lint error or a red suite blocks
  packaging and therefore the release.
- `npx vsce ls` lists exactly what ships, controlled by `.vscodeignore`.
- `README.md` reads well: it becomes the store page, minus any block marked
  `<!-- github-only --> ... <!-- /github-only -->`, which is where the centred
  icon lives (the Marketplace draws its own). `npm run package` writes that copy
  to `README.marketplace.md` and hands it to `vsce` with `--readme-path`;
  `README.md` itself is in `.vscodeignore`, because two files would collide as
  `readme.md` inside the .vsix. `assets/icon.png` and `LICENSE` are present.
- The `repository` URL in `package.json` points at a repository that exists
  **and is public**. `vsce` rewrites every relative image in the README to
  that repository's raw URL, so until the repository is there the store page
  shows broken images. Check the rewritten copy with
  `npm run package && unzip -p claude-code-tts-*.vsix extension/readme.md | head`.

## When something fails

| What you see | What it means |
|---|---|
| `The requested operation is not allowed` | The identity is not a member of the publisher. Steps 6 and 7. |
| `Access Denied: <guid> needs ... View user permissions on a resource /giladreich` | The same thing, said by the newer API, and the guid is the identity being refused. Compare it with the member list in [Finding an id](#finding-an-identitys-azure-devops-id): a workflow that fails while your own machine publishes means your id was added and the workflow's was not. |
| `TF14045: The identity could not be found` | The member list cannot resolve what you pasted. It wants the Azure DevOps profile id from step 6; Entra ID GUIDs mean nothing to it. |
| `TF401444: Sign-in required` | The identity is known but has no publishing rights. Add it as **Contributor**, not a lesser role. |
| `Identity with id ... is invalid`, adding a user to an Azure DevOps organization | An organization accepts identities only from the Entra tenant it is connected to, and one created with a personal Microsoft account is connected to none. Skip it: publishing needs steps 6 and 7, not an organization. |
| The sign-in step finds no matching federated credential | The subject does not match. The credential must be scoped to the **environment** `release` (step 3), because the release runs on a tag. |
| `Set the AZURE_CLIENT_ID and AZURE_TENANT_ID repository variables` | The run stopped before signing in. Step 4. |
| The id step fails before printing anything | The sign-in failed: the environment (step 5) or the federated credential (step 3) does not match. |
| `Version number must increase each time an extension is published` | That version is already on the Marketplace. Bump `package.json`, the lockfile and the changelog, then tag again. |
