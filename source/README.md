# Stickform source

TypeScript + three.js r186, bundled with esbuild into one self-contained page, `../stickform.html` (already built and included in the repository, so you only need this folder to change the code).

## Layout

| Path | What it does |
|---|---|
| `src/sketch/geom.ts` | 2D stroke geometry (bend points, loops, corners). |
| `src/sketch/tagger.ts` | Auto-tagging: strokes to head, tick, spine, crossbars, arms, legs. |
| `src/sketch/lifter.ts` | Tagged strokes to 3D stick-figure joints: three-segment spine, depth from foreshortening or the depth table, torso facing. |
| `src/sketch/pose3d.ts` | The pose as bone directions: rebuild joints, carry children, mirror, snap, nudge, regenerate a clean drawing, view bases. |
| `src/sketch/ik.ts` | IK for dragging: a grabbed point on any bone follows the pointer as a free chain (limb first, then the spine within limits for arms, chest and neck, then the whole body moves); pinned arms and legs keep their hands and feet where they are and limit how far the body can go. Also the two-bone solve used by Reach to… and Attach. |
| `src/sketch/edits.ts` | Edit-pen solver: a guide in any view to bone directions for a part. |
| `src/ui/help.ts` | The help box's words: for each tool and each situation (selected bone, whole character, Reach to…, drafts, Scene view) a title, keys and short lines, as HTML. Placement lives in `main.ts`. |
| `src/ui/posing.ts` | Posing UI: drafts, Apply/Discard, pins and the whole-character lock, picking in every view, nudges and match tools, Reach to… (two-bone reach onto any character) and Attach (lasting contacts: hold, detach, edits detach, loop check), IK drags in every view (select tool: drag a bone), contact markers, the hover glow, the rotate gizmo, extra sketch views (Character and Scene modes, drag to arrange), the faint other characters, 3D ink layers. |
| `src/sketch/canvas.ts` | The sketch surface: pen, select, erase, tag brush, edit pen, undo and redo, page placement. |
| `src/three/rig.ts` | Standard bone slots (VRM humanoid names), rest pose capture, facing. |
| `src/three/mannequin.ts` | Built-in mannequin, and its colour per character. |
| `src/three/loadModel.ts` | GLB/VRM loading and automatic bone mapping. |
| `src/three/retarget.ts` | Poses a rig from the stick-figure joints (frames for torso and head, the head nodding with the facing up to 70°, bend planes for limbs). |
| `src/three/props.ts` | Objects: the ten shapes (faces wound outward), reading GLB/GLTF/OBJ files (standing on the floor, a size guess for files in cm), placing an object (bottom centre, turn about its middle, scale from its bottom), and the Look of any loaded model (Original, Tint: its textures coloured, Solid: one colour; both keep cut-out transparency). |
| `src/three/view.ts` | Shared stage (one group per character, plus objects), placing a character (move, turn about the hips, scale from the floor under them), 3D viewports (output camera with frame, free orbit), camera presets (frame all or the active character, optionally turned with it), PNG export. |
| `src/io/pose.ts` | Pose files and the preset library, and scene files (`stickform-scene`: several characters, their looks, objects, Everything in solid colours). |
| `src/io/project.ts` | The project folder, through the local server when the page came from it, else the File System Access API (remembered folder handle), list/read/write/rename/delete in `presets/`, `models/`, `renders/`, `objects/`, and the optional save dialog. |
| `src/presets.json` | Built-in presets. |
| `src/main.ts` | The drawing anchor (one page-to-world map per scene; each character's page registration; the others in the front sketch as drawn), new figures (strokes drawn apart wait, then become a character standing where drawn, up/down too; strokes on a faint figure go to that character), objects (held by characters: follow a bone; spots on objects for hands and feet; lock and link signs; random colours; the Colour & look card; + Add menu, Scene card rows, selection, dragging, Up/Down lift, numbers incl. linked scale, looks, Everything in solid colours, tabs, undo and scene files), open tabs (documents: each a pose or scene with its own characters, file and undo history), saving (the Save button and its menu, overwrite protection, Save as), the scene (characters: switching, posing the others, model copies, scene files, contacts kept touching after every change, Stick contacts pulling the other character along, saved in scene files), the help box (which view it shows in, placement and size) and Studio UI wiring: header, viewport grid layout and docking, tools, selection pill, draft list, inspector (incl. the character lock), project folder (saving, characters, Library, Renders with rename, delete and the full-screen preview), settings, theme and viewport colours, shortcuts. |
| `server/stickform-server.mjs` | "Start Stickform": a dependency-free local server (127.0.0.1 only) that serves the app and reads, writes, renames (never over another file) and deletes in `presets/`, `models/`, `renders/`, `objects/`. Options: `--no-open`, `--port N`, `--root DIR`. |
| `vendor/three/` | Vendored three.js r186 (MIT): core build plus GLTFLoader, OrbitControls and their helpers. |
| `index.html` | Page layout and styles (Studio). |
| `scripts/build.mjs` | Bundles and inlines everything into `../stickform.html`. |
| `scripts/export-public.mjs` | Used by the maintainer to prepare this repository from a private working folder. It does nothing useful in a clone and is not needed to build, run or test. |
| `scripts/docs-check.mjs` | Maintainer's check that the documentation is up to date with the code. Like the export, it only works in the maintainer's folder layout and is not needed to build, run or test. |
| `tests/` | The test suite (see `tests/README.md`). |

## Building (only needed to change the code)

Needs Node.js 18 or newer.

```
npm install          # esbuild, typescript, @types/three@0.186, playwright
npx playwright install chromium   # once, for the tests
npm run typecheck
npm run build        # writes ../stickform.html
npm test             # build, then run the test suite
```

three.js itself is vendored, so `npm install` only fetches build tools, type definitions and the test browser driver.
