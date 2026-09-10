# MARS — Design System & Landing Page Handoff

## 0. Purpose

This document defines the visual direction, layout system, component language, asset usage, and implementation guardrails for the MARS landing page.

MARS is an AI agent harness / multi-model orchestration runtime.

The goal is **not** to create a generic AI SaaS landing page.

The visual identity should feel:

- editorial;
- mythic;
- technical;
- tactile;
- disciplined;
- print-inspired;
- developer-first.

The clearest visual reference is an **editorial tech site with strong typography, off-white paper-like surfaces, saturated color rails, monospaced labels, high-contrast serif display text, and dithered/halftone artwork**.

However:

> Do not copy Hermes Agent's page structure, colors, exact typography, copy, imagery, or interactions.

MARS must feel like its own brand.

---

# 1. Brand Thesis

The MARS visual world should express:

```text
MYTHOLOGY
    +
TECHNICAL CONTROL
    +
EDITORIAL PRINT
    +
MARS RED
```

The mythological side should be present through:

- monumental composition;
- Roman/Mars imagery;
- ceremonial symmetry;
- bust / deity iconography;
- disciplined hierarchy;
- carved / printed / dithered aesthetics.

The technical side should be present through:

- monospace labels;
- terminal snippets;
- CLI/install blocks;
- structured grids;
- numbered sections;
- fine rules;
- code examples;
- routing/orchestration diagrams;
- restrained controls.

Do not use literal weapons.

Avoid:

- spears;
- swords;
- shields as primary visual motifs;
- generic helmet logos;
- pseudo-Roman roleplay in product naming.

The mythology should feel **cultural and graphic**, not cosplay.

---

# 2. Core Design Direction

The final direction is:

> **Editorial Mars / Mythic Developer Tool**

Primary characteristics:

```text
warm bone background
strong Mars red
deep oxide red
charcoal text
high-contrast serif display typography
monospaced labels and body copy
dithered / halftone assets
paper grain
thin red rules
structured editorial grid
large negative space
minimal UI chrome
```

This should feel more like:

```text
experimental editorial website
+
developer product documentation
+
modern identity system
```

than:

```text
dark sci-fi landing page
```

---

# 3. Color System

Use the following palette as the starting token set.

```css
--mars-red:       #B51E16;
--mars-red-deep:  #8B1E16;
--oxide:          #A9493A;
--dust:           #D7A692;
--bone:           #F7F2EB;
--bone-muted:     #EFE7DC;
--charcoal:       #1E1E1E;
--charcoal-soft:  #34312F;
--paper-line:     rgba(181, 30, 22, 0.25);
```

Optional darker utility tone:

```css
--void: #0B0B0B;
```

## Usage ratio

Aim approximately for:

```text
60–70% Bone / warm neutral
20–30% Mars red / oxide
5–10% Charcoal
```

The site should **not** become a red page with white cards.

The page should feel primarily like printed editorial matter placed inside a Mars-red environment.

---

# 4. Background Strategy

Recommended page structure:

```text
MARS RED OUTER CANVAS
        ↓
BONE CONTENT SURFACE
        ↓
EDITORIAL SECTIONS
```

Desktop:

```text
<body background = mars red / subtle grain>

<main>
  max-width: 1480px
  background: bone
</main>
```

The outer red margins should remain visible.

Suggested:

```css
body {
  background: var(--mars-red-deep);
}

.site-shell {
  max-width: 1480px;
  margin-inline: auto;
  background: var(--bone);
}
```

Mobile:

Maintain small red side rails:

```text
8–16px
```

Do not remove them completely.

They are part of the brand.

---

# 5. Texture

Texture matters.

The page should not feel digitally sterile.

Use extremely subtle:

- paper grain;
- ink noise;
- halftone patterns;
- distressed image edges.

Do **not** place aggressive noise over all text.

Recommended implementation:

```css
.paper {
  position: relative;
}

.paper::after {
  content: "";
  pointer-events: none;
  position: absolute;
  inset: 0;
  opacity: 0.025;
  mix-blend-mode: multiply;
  background-image: url("/textures/paper-noise.png");
}
```

If no paper texture asset exists, generate it with CSS/noise only if lightweight.

Do not use large video backgrounds.

---

# 6. Typography

Typography is critical.

The page should rely on a three-layer system.

## 6.1 Display serif

Use for major section headlines.

Desired qualities:

- high contrast;
- editorial;
- elegant;
- slightly dramatic;
- not pseudo-classical;
- not Trajan.

Examples of appropriate direction:

```text
Instrument Serif
Bodoni Moda
Cormorant Garamond
DM Serif Display
Source Serif 4
```

Prefer something readable and contemporary.

Suggested starting point:

```text
Instrument Serif
```

Usage:

```text
A MORE
CAPABLE SYSTEM

MANY MODELS
ONE HARNESS

PERSISTENT
CONTEXT
```

Large desktop scale:

```css
font-size: clamp(4rem, 8vw, 8.5rem);
line-height: 0.84;
letter-spacing: -0.04em;
```

Mobile:

```css
font-size: clamp(3rem, 14vw, 5.3rem);
```

---

## 6.2 Monospace

Use for:

- labels;
- section numbers;
- metadata;
- buttons;
- body copy where appropriate;
- install commands;
- code;
- side notes.

Good candidates:

```text
IBM Plex Mono
Geist Mono
Commit Mono
JetBrains Mono
```

Suggested:

```text
IBM Plex Mono
```

Use uppercase with letter spacing for microcopy.

Example:

```text
#1 ORCHESTRATE

MODEL ROUTING
TOOL USE
MEMORY
EXECUTION
```

---

## 6.3 Geometric sans

Optional third layer for:

- nav;
- wordmark support;
- compact UI.

Good candidates:

```text
Geist
Inter
Instrument Sans
Söhne-like grotesk
```

Keep its role small.

Do not let the sans become the primary visual language.

---

# 7. Logo

Primary product name:

```text
MARS
```

Current brand direction uses:

- geometric M mark;
- MARS wordmark;
- Mars-red tone;
- mythic-tech geometry.

The current mark should be treated as **architectural / symbolic**, not as a literal illustration.

Recommended logo modes:

```text
PRIMARY
symbol + wordmark

COMPACT
symbol only

EDITORIAL
halftone / distressed symbol

MONO
single-color red

REVERSED
bone on Mars red
```

Do not use 3D glossy logo treatments in the final production site.

If any 3D exploration survives, use it only for social/promotional imagery.

---

# 8. Current Assets

The following visual assets have been created and should be treated as part of the design direction.

## 8.1 Dithered Mars deity bust

Current asset:

```text
/mnt/data/busto_romano_en_halftono_rojo.png
```

Purpose:

```text
hero support
editorial feature section
about / philosophy section
mobile visual break
footer composition
```

It is a red dithered / halftone depiction of Mars on transparent background.

Do not place it on complex photo backgrounds.

Best backgrounds:

```text
bone
oxide
dark red
```

Preferred compositions:

```text
cropped at shoulder
partially outside section bounds
large scale
not centered like an avatar
```

Example:

```text
left column: headline + copy
right column: deity bust, oversized
```

or:

```text
full-width section
portrait aligned right
headline overlapping whitespace on left
```

---

## 8.2 Dithered Mars planet

Current asset:

```text
/mnt/data/planeta_marte_rojo_en_halftono.png
```

Transparent background.

Purpose:

```text
hero background anchor
section divider
decorative oversized crop
footer visual
subtle parallax element
```

Do not render the full disk at normal size everywhere.

Prefer cropping:

```text
right half off-screen
bottom horizon
large background circle
masked section edge
```

Example:

```css
.planet {
  position: absolute;
  width: min(80vw, 900px);
  right: -20%;
  top: 10%;
  opacity: 0.9;
}
```

---

# 9. Image Style

Any additional imagery must follow the same system.

Allowed:

- halftone;
- dither;
- risograph-like;
- engraved;
- duotone red;
- screenprint;
- archival-tech;
- xerox texture.

Avoid:

- glossy AI-rendered cinematic art;
- photorealistic planets;
- astronauts;
- generic sci-fi landscapes;
- neon galaxy backgrounds;
- cyberpunk cities;
- generic 3D gradients.

If another image is needed, it should look like it belongs in the same printed publication as the Mars bust.

---

# 10. Landing Page Structure

Recommended final structure.

```text
01 HEADER
02 HERO
03 MANIFESTO / WHAT MARS IS
04 ORCHESTRATE
05 CONTEXT
06 EXECUTE
07 CLI / INSTALL
08 HOW IT WORKS
09 OPEN SOURCE
10 FOOTER
```

Do not turn this into a 20-section SaaS landing page.

---

# 11. Header

Desktop:

```text
MARS LOGO

PRODUCT
DOCS
GITHUB
COMMUNITY

[ GET STARTED ]
```

Visual treatment:

- transparent / bone background;
- thin red bottom rule;
- compact;
- no floating glass navbar;
- no heavy shadow.

Suggested:

```css
height: 72px;
border-bottom: 1px solid var(--paper-line);
```

Mobile:

```text
MARS
[ MENU ]
```

Menu should open as a full editorial sheet, not a generic floating dropdown.

---

# 12. Hero

The hero should communicate:

```text
WHAT MARS IS
WHY IT EXISTS
HOW TO START
```

Recommended structure:

```text
left:
  micro label
  display headline
  short technical description
  CTA

right:
  dithered Mars planet
  optional deity crop
```

Possible content hierarchy:

```text
AI AGENT HARNESS

MANY MODELS.
ONE SYSTEM.

MARS coordinates models, agents, tools,
context and execution through one programmable runtime.

[ GET STARTED ]
[ VIEW ON GITHUB ]
```

Avoid:

```text
"Reimagine intelligence."
"Orchestrate the future."
"Unlock autonomous potential."
```

Copy must remain technical and concrete.

---

# 13. Hero Layout

Desktop:

```text
12-column editorial grid

headline: columns 1–7
planet: columns 7–12
```

The planet may overlap the content grid.

Do not put it inside a card.

Suggested:

```text
hero min-height: 850px
```

The hero should feel more like a poster spread than a SaaS hero.

---

# 14. Section Pattern

Sections should use the recurring pattern:

```text
#1 LABEL

LARGE SERIF HEADLINE

HALFTONE VISUAL

MONOSPACE EXPLANATION
```

Example:

```text
#1 ORCHESTRATE

MANY MODELS
ONE HARNESS

[visual]

ROUTE TASKS TO THE RIGHT MODEL.
COORDINATE SPECIALIZED AGENTS.
REVIEW OUTPUT THROUGH SHARED RULES.
```

Use variation within the pattern so the page does not become repetitive.

---

# 15. Section 1 — Orchestrate

Heading:

```text
MANY MODELS
ONE HARNESS
```

Side metadata:

```text
OPENAI
ANTHROPIC
GOOGLE
OPENROUTER
LOCAL
CUSTOM
```

Visual can use:

- abstract routing diagram;
- giant M mark;
- dithered gate;
- simple model topology.

Avoid brand logo soup if provider support is not final.

---

# 16. Section 2 — Context

Heading:

```text
PERSISTENT
CONTEXT
```

Explain:

```text
PROJECT MEMORY
TEAM KNOWLEDGE
TOOL STATE
SHARED RULES
LONG-RUN TASKS
```

Use the dithered Mars deity bust prominently here.

Suggested composition:

```text
left:
  deity bust

right:
  #2 REMEMBER
  PERSISTENT CONTEXT
  explanation
```

or inverse on mobile.

The deity can symbolize:

```text
memory
continuity
discipline
reasoning
```

Avoid explicit marketing claims around "never marsts" unless technically accurate.

---

# 17. Section 3 — Execute

Heading:

```text
DEPLOY
ANYWHERE
```

Metadata:

```text
LOCAL
CLOUD
YOUR INFRASTRUCTURE
WORKERS
CI
TERMINAL
```

Use a large cropped planet horizon.

This should be a visually quieter section.

---

# 18. CLI / Install Section

This is product-critical.

It should look like part of the editorial system rather than a generic black terminal card.

Recommended:

```text
INSTALL MARS

npm
pnpm
source
```

Example placeholder:

```bash
npm install -g @rubicon/mars
```

Do **not** ship a fictional command if package naming is not final.

Implementation should source the install command from config:

```typescript
export const INSTALL_COMMAND = "..."
```

Terminal visual:

```text
bone section
charcoal command block
red command text
thin border
square or slightly rounded corners
```

Keep radius subtle:

```css
border-radius: 4px–8px;
```

Avoid huge 24px SaaS radii.

---

# 19. "How It Works" Section

Use a simple topology.

Example:

```text
USER
  │
  ▼
MARS
  ├── PLANNER
  ├── CODE AGENT
  ├── REVIEWER
  └── TOOL RUNNER
        │
        ▼
      OUTPUT
```

Or multi-model version:

```text
                   MARS
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      CODEX       CLAUDE      GEMINI
        │           │           │
        └───────────┼───────────┘
                    ▼
                  RESULT
```

Style:

- thin red lines;
- small mono labels;
- no glowing nodes;
- no 3D topology.

---

# 20. Cards

Use cards only when they communicate structured information.

Do not build the page from nested cards.

Recommended card style:

```css
border: 1px solid var(--paper-line);
background: transparent;
border-radius: 0;
```

or:

```css
border-radius: 4px;
```

Avoid:

```text
rounded-3xl
glass blur
box shadows
floating gradients
```

Cards should feel like editorial boxes.

---

# 21. Buttons

Buttons should feel print-like.

Primary:

```text
MARS RED background
BONE text
square-ish
small mono uppercase
```

Secondary:

```text
transparent
red border
red text
```

Example:

```css
.button {
  min-height: 44px;
  padding-inline: 22px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
  border-radius: 2px;
}
```

No pill buttons unless specifically used as a tiny filter/control.

---

# 22. Micro Labels

This is a core part of the visual language.

Examples:

```text
#1 ORCHESTRATE
#2 REMEMBER
#3 EXECUTE

FEATURE
PREVIEW

MODEL ROUTER
RUNTIME
```

Style:

```css
font-family: var(--font-mono);
font-size: 11–13px;
letter-spacing: .16em;
text-transform: uppercase;
```

Use red.

---

# 23. Rules and Dividers

Thin red rules should organize the page.

Use:

```css
border-color: rgba(181, 30, 22, 0.25);
```

Avoid gray separators.

The red rule is part of the brand.

---

# 24. Grid

Desktop:

```text
12 columns
max content width 1320–1440px
24–32px gutters
```

Editorial sections should not all share the same component width.

Use controlled asymmetry.

Example:

```text
headline: 7 columns
metadata: 3 columns
2 columns whitespace
```

This is preferable to:

```text
50 / 50 split everywhere
```

---

# 25. Spacing

Large vertical rhythm.

Recommended section spacing:

```css
padding-block: clamp(88px, 10vw, 160px);
```

The design depends on breathing room.

Do not compact everything to fit above the fold.

---

# 26. Motion

Motion should be restrained.

Allowed:

- image reveal;
- subtle parallax;
- clip-path reveal;
- text mask reveal;
- planet slow drift;
- fine line drawing;
- small hover translation.

Avoid:

- bouncing cards;
- excessive spring animations;
- floating UI;
- endless glowing particles;
- mouse-follow blobs.

Suggested:

```text
planet moves 20–40px during scroll
portrait reveals through vertical mask
rules animate width
```

Respect:

```css
@media (prefers-reduced-motion: reduce)
```

All decorative motion must disable cleanly.

---

# 27. Planet Motion

The Mars planet asset can be used subtly.

Example:

```typescript
transform: translateY(scrollProgress * 24px)
```

Do not rotate quickly.

If rotating at all:

```text
< 2 degrees across whole viewport section
```

The asset should feel monumental.

---

# 28. Dithered Mars Portrait Motion

Do not animate the figure itself dramatically.

Possible:

```text
fade 0 → 1
translateY 20px → 0
clip-path reveal
```

Avoid:

```text
3D head tracking
cursor movement
glitching
```

The deity is a brand artifact, not an interactive mascot.

---

# 29. Responsive Strategy

Mobile is first-class.

Reference behavior:

```text
red outer rails remain visible
bone editorial surface
large headlines
image width nearly full
mono paragraphs
stacked content
```

Mobile section order:

```text
label
headline
visual
metadata
copy
```

Do not put metadata side-by-side with large headings on narrow screens.

---

# 30. Mobile Typography

Display heading:

```css
font-size: clamp(3rem, 14vw, 5rem);
line-height: .88;
```

Body mono:

```css
font-size: 13px;
line-height: 1.6;
letter-spacing: .07em;
```

Navigation:

```css
font-size: 12px;
```

Do not scale the display type down too aggressively.

Its scale is part of the identity.

---

# 31. Mobile Header

Preferred:

```text
MARS                       MENU
──────────────────────────────
```

When open:

```text
PRODUCT
DOCS
GITHUB
COMMUNITY

GET STARTED
```

Use full-height bone panel with red typography.

No hamburger animation theatrics needed.

---

# 32. Footer

Footer should feel like the final page of a publication.

Possible layout:

```text
MARS

DOCS
GITHUB
RUBICON LABS

BUILD WHAT COMES NEXT.

MMXXVI
```

Use a large horizontal rule.

Possible oversized dithered planet crop behind or above footer.

Do not overload social icons.

---

# 33. Copy Style

Tone:

```text
technical
short
precise
human
confident
```

Avoid:

```text
transformative
revolutionary
next-generation
unlock potential
reimagine
seamless
supercharge
```

Good:

```text
Route tasks to the right model.

Give agents shared rules and context.

Run locally or through remote providers.

Keep the harness under your control.
```

---

# 34. Product Vocabulary

Preferred:

```text
Harness
Runtime
Agent
Model
Provider
Tool
Context
Router
Worker
Task
Run
Rule
Skill
Execution
```

Avoid inventing mythological names for basic technical concepts unless the naming has product value.

Bad:

```text
Centurion Router
Augur Memory
Legion Workers
```

Marketing visuals can be mythic.

DX should remain obvious.

---

# 35. Accessibility

Minimum:

- WCAG AA contrast;
- keyboard navigation;
- visible focus states;
- alt text;
- no text embedded in image assets for critical information;
- semantic headings;
- reduced motion support.

Red-on-bone should be checked.

Do not use the light Dust tone for body copy.

---

# 36. Image Accessibility

Decorative assets:

```html
alt=""
```

If Mars portrait communicates brand only, it is decorative.

If an image is illustrating a specific section concept, write concise descriptive alt text.

Do not describe irrelevant aesthetic details.

---

# 37. Performance

The page must remain fast.

Required:

- use WebP/AVIF where practical;
- transparent PNG only where alpha is required;
- responsive images;
- lazy-load below-the-fold assets;
- do not ship enormous uncompressed textures;
- preload critical fonts only;
- avoid video hero.

The Mars bust and planet assets should be optimized before production.

Potential command:

```bash
sharp input.png -o output.webp
```

Keep original transparent PNG source.

---

# 38. Asset Placement

Suggested local project paths:

```text
/public/brand/mars-god-halftone.png
/public/brand/mars-planet-halftone.png
/public/brand/mars-logo.svg
/public/textures/paper-noise.webp
```

When integrating the current assets, copy them from:

```text
/mnt/data/busto_romano_en_halftono_rojo.png
/mnt/data/planeta_marte_rojo_en_halftono.png
```

Preserve originals.

---

# 39. Recommended Project Component Structure

```text
components/
  mars/
    Header.tsx
    Hero.tsx
    EditorialSection.tsx
    SectionLabel.tsx
    InstallBlock.tsx
    OrchestrationDiagram.tsx
    MarsPortrait.tsx
    MarsPlanet.tsx
    Footer.tsx
```

Design primitives:

```text
components/ui/
  Button.tsx
  Rule.tsx
  MonoLabel.tsx
  CopyButton.tsx
```

Do not create a generic design system with 50 primitives before the landing page exists.

---

# 40. CSS Tokens

Suggested:

```css
:root {
  --mars: #B51E16;
  --mars-deep: #8B1E16;
  --oxide: #A9493A;
  --dust: #D7A692;
  --bone: #F7F2EB;
  --bone-muted: #EFE7DC;
  --charcoal: #1E1E1E;

  --line: color-mix(in srgb, var(--mars) 25%, transparent);

  --content-max: 1440px;
  --page-gutter: clamp(20px, 4vw, 64px);

  --section-space: clamp(88px, 10vw, 160px);

  --radius-sm: 4px;
}
```

---

# 41. Do Not

Do not implement:

```text
purple gradients
glassmorphism
generic AI blobs
neon blue
floating 3D cubes
giant rounded cards
glowing provider logos
astronaut stock art
photorealistic Mars renders
Trajan typography
Roman columns everywhere
weapon imagery
scroll-jacking
over-animated cursor
massive shader background
```

Also avoid:

```text
copying Hermes navigation
copying Hermes exact section names
copying Hermes copy
copying Hermes visual assets
copying its blue palette
```

MARS is inspired by an editorial direction, not a clone.

---

# 42. Anti-Slop Rules

Every major section must answer:

```text
Why does this visual exist?
```

No decorative card if:

```text
headline + rule + image
```

would communicate the same thing better.

No icon unless it provides real scanning value.

No gradient unless it serves image integration or hierarchy.

No badge unless it represents real status.

No fake metrics.

No invented GitHub star counts.

No fake provider support.

No fake install commands.

---

# 43. Landing MVP

The first design implementation does not need every planned section.

Ship this first:

```text
Header
Hero
Orchestrate
Persistent Context
Deploy Anywhere
Install
Footer
```

Use the two existing assets.

That is enough to establish the brand.

---

# 44. Suggested First-Pass Copy

Temporary copy only.

## Hero

```text
AI AGENT HARNESS

MANY MODELS.
ONE SYSTEM.

MARS is a programmable harness for coordinating
models, agents, tools and context from one runtime.

GET STARTED
VIEW ON GITHUB
```

## Orchestrate

```text
#1 ORCHESTRATE

MANY MODELS
ONE HARNESS

Route work to the right model.
Coordinate specialized agents.
Keep execution under one control plane.
```

## Context

```text
#2 REMEMBER

PERSISTENT
CONTEXT

Project state, shared rules and working context
should survive beyond a single agent run.
```

## Execute

```text
#3 EXECUTE

DEPLOY
ANYWHERE

Run locally, connect remote providers,
or extend the harness to your own infrastructure.
```

Do not treat this copy as final product truth.

Update it as implementation solidifies.

---

# 45. Suggested Visual Composition

Hero:

```text
┌─────────────────────────────────────────────┐
│ MARS                           DOCS   GITHUB │
├─────────────────────────────────────────────┤
│                                             │
│ # AI AGENT HARNESS                          │
│                                             │
│ MANY MODELS.              [ DITHERED MARS ] │
│ ONE SYSTEM.                                 │
│                                             │
│ copy                                        │
│ [ GET STARTED ] [ GITHUB ]                  │
│                                             │
└─────────────────────────────────────────────┘
```

Orchestrate:

```text
#1 ORCHESTRATE

MANY MODELS
ONE HARNESS

────────────────────────────────────────

[ DIAGRAM / HALFTONE VISUAL ]

ROUTE / COORDINATE / REVIEW
```

Context:

```text
[ MARS GOD ASSET ]      #2 REMEMBER

                        PERSISTENT
                        CONTEXT

                        PROJECT MEMORY
                        SHARED RULES
                        LONG-RUN STATE
```

Execute:

```text
#3 EXECUTE

DEPLOY
ANYWHERE

[ CROPPED MARS PLANET HORIZON ]
```

---

# 46. Acceptance Criteria

The design implementation is on direction when:

1. The page is primarily bone + Mars red, not dark SaaS black.
2. The page has visible editorial print influence.
3. Display serif typography is central to the identity.
4. Monospace labels provide the developer-tool layer.
5. At least one dithered Mars asset is integrated prominently.
6. The page does not look like a generic AI startup.
7. The layout works strongly on mobile.
8. The red side rails / outer field remain part of the composition.
9. Sections are structured by rules, typography, and imagery rather than nested cards.
10. Mars mythology is visible but restrained.
11. The CLI/product layer remains technically clear.
12. The page does not visually copy Hermes.
13. Animations remain restrained.
14. Real product claims are not invented.
15. The site remains fast.

---

# 47. First Codex Design Task

Implement only the visual shell and first three core sections.

Deliver:

```text
Header
Hero
OrchestrateSection
ContextSection
ExecuteSection
```

Use:

```text
Mars deity asset
Mars planet asset
```

Create:

```text
design tokens
font configuration
responsive grid
paper texture treatment
section label primitive
button primitive
editorial rule primitive
```

Do not implement:

```text
docs
auth
pricing
complex navigation
provider integrations
canvas diagrams
advanced animation
```

until the visual language is stable.

---

# 48. Build Priority

Prioritize in this order:

```text
1. typography
2. composition
3. whitespace
4. asset integration
5. responsive behavior
6. color
7. texture
8. motion
```

Do not compensate for weak layout with animation.

---

# 49. Final Design Principle

Every section should feel like it belongs to a single editorial publication about a technical system.

The core test:

> **Would this still look like MARS if all gradients and animations were removed?**

If the answer is no, the visual identity is too dependent on effects.

MARS should remain recognizable through:

```text
red
bone
serif
mono
dither
rules
scale
mythic restraint
technical clarity
```

That is the design system.
