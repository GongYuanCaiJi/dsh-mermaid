# Third-party notices

## pi-mermaid

This package is a port of `pi-mermaid`. The upstream source is used under the MIT License.

| | |
|---|---|
| Package | [`pi-mermaid@0.3.0`](https://www.npmjs.com/package/pi-mermaid) |
| Repository | [Gurpartap/pi-mermaid](https://github.com/Gurpartap/pi-mermaid) |
| Author | Gurpartap Singh |
| License | MIT |
| Tarball | `https://registry.npmjs.org/pi-mermaid/-/pi-mermaid-0.3.0.tgz` |
| Integrity | `sha512-U6sCqyb/dx6HL5bLu8jFwrHbCpXidjW+DuVaiBxlSIY4zy8lyotRCYSzL+z9ftcltRfFyAtvaeKTLdGH18KG7g==` |
| shasum | `28badf489f54c792449caafc9a0ea906528e06ab` |
| gitHead | `34cab3ae794422d43707f129120a73ea39f51742` |

### What this port keeps verbatim

There is no byte-identical file: upstream `index.ts` is a Pi extension
(`export default (pi)` + TUI renderer), which cannot run inside dsh. What is
copied unchanged is the **pure logic** — constants, regexes, limits, and the
following functions, line-for-line from upstream `index.ts`:

- `MERMAID_BLOCK_RE`, `ISSUE_LINE_RE`, `COLLAPSED_LINES`, `MAX_BLOCKS`,
  `MAX_SOURCE_LINES`, `MAX_SOURCE_CHARS`, `MAX_SEEN_ISSUES`, `MAX_SVG_CACHE`
  (upstream `MAX_ASCII_CACHE`), `SUPPORTED_TYPES`, `SUPPORTED_TYPE_LABEL`
- `isDomPurifyError`, `getMermaidParser`, `normalizeMermaidSource`,
  `formatIssueLines`, `buildContextContent`, `extractText`,
  `extractMermaidBlocks`, `getMermaidTypeToken`, `getSupportedMermaidType`,
  `hashMermaid`, `splitIssuesFromContent`, `getLastAssistantText`,
  `processBlock`

The adaptation surface is deliberately small and documented in the README:
dsh entry shape (`{ name, apply }`), `ctx.on('session/event')` instead of
`pi.on('input' | 'agent_end')`, `renderMermaidSVG` instead of
`renderMermaidAscii` (same `beautiful-mermaid` package, dsh has a web client
not a TUI), and the TUI renderer replaced by a web client slot.

### Verifying the upstream pin yourself

Fetch the pinned tarball and compare the logic you care about:

```bash
curl -sL https://registry.npmjs.org/pi-mermaid/-/pi-mermaid-0.3.0.tgz | tar xz
sha256sum package/index.ts   # compared against the values below
```

Expected SHA-256 of the upstream tarball members (also stored in `.upstream/`):

```
3ed30cd36f939b83272546398e09889b953f34109cfe9442704943577052fb92  index.ts
bb98ba459c95cb19c912a4be768beacc1207a1da665711b3cf629be742ef058c  README.md
548179880436c7fbcfdc179a98cb9e6218665296f2fae3c1e8687938b360b08c  package.json
ab9130b38387ad27a22eb0df13a67b06736de2a4bd262565b3423b5d951a8d94  LICENSE
```

The `.upstream/` directory in this repo is the unpacked upstream tarball
(gitignored; re-fetch with the command above if missing).
