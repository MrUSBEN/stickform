# Stickform

Draw a rough stick figure, and a 3D character takes the pose. Save the posed character as a PNG render and use it
as a pose reference, for example for an image-editing model. Posing is meant to be quicker than dragging joints one
by one.

Stickform is a personal project and a work in progress. It runs in your browser, on your own computer, and nothing
is uploaded anywhere.

## What it does

- **Sketch to pose.** Draw a head circle, a spine, a small tick for the direction the face points, arms and legs.
  Stickform recognises the parts by itself and turns the drawing into a 3D pose.
- **Any humanoid.** There is a built-in mannequin. You can also load your own rigged humanoid characters (GLB or VRM).
- **Edit by drawing.** Redraw any part (spine, neck, arms, legs, shoulders, hips, facing) over the sketch, a side,
  back or top view, or the 3D view. Rotate gizmos, drag-to-pose IK and exact numbers are there for precision.
- **Several characters and objects.** Put any number of characters and simple props in one scene. Hands and feet can
  reach for, and stay attached to, other characters or objects; objects can be held.
- **Render.** Pick a camera (front, three-quarter, side or free), an aspect ratio and a background, and save a PNG.

## Run it

You need [Node.js](https://nodejs.org) (version 18 or newer). Nothing else has to be installed.

**Windows:** double-click `Start Stickform.bat`. A small window opens (keep it open while you work) and Stickform
opens in your browser. Close the window to stop it.

**Other systems:**

```
node source/server/stickform-server.mjs
```

and open the address it prints (`http://127.0.0.1:5178/`).

The little server only listens on your own computer. It lets the app save poses to `presets/`, load characters
from `models/`, load props from `objects/` and write renders to `renders/`, all inside this folder.

You can also open `stickform.html` directly in a browser. In Chrome or Edge, click **Connect folder** once to get
the same saving; other browsers download files instead.

## Basic workflow

1. Press **Settings › Restore starter poses** to put ten example poses into `presets/`, then click one, or draw
   your own with the pen: a head circle, a spine, a short tick from the head's centre for the facing, then arms and legs.
   Click a stroke to retag it if it was read wrongly.
2. Press **D** (edit pen) and draw over any part to reshape it. Apply a draft with Enter, discard it with Esc.
   Press **V** (select) and click a bone to use its gizmo or type exact numbers in the Pose card; drag a bone to
   move it by IK. **K** pins a part, and the lock freezes the whole character.
3. Use **+ Add** in the Scene card for more characters or objects. Reach to… (R) puts a hand or foot on a spot;
   Keep attached makes it stay there.
4. Choose a camera, aspect ratio and background, then **Render PNG** (Ctrl Enter). Renders appear in the Renders tab.
5. Save with **Save** (Ctrl S). Poses and scenes are plain `.stickform.json` files in `presets/`.

The round **!** button in each viewport's title bar shows a help box with the keys for the current tool, and the
gear lists every keyboard shortcut.

## Folders

| Folder | Contents |
|---|---|
| `presets/` | Your saved poses and scenes. Starts empty. |
| `models/` | Optional characters (GLB or VRM). Starts empty; see `models/README.md`. |
| `objects/` | Optional props (GLB, GLTF or OBJ). Starts empty; see `objects/README.md`. |
| `renders/` | Your renders. Starts empty. |
| `source/` | The source code and tests; see `source/README.md`. |

Whatever you put in `presets/`, `models/`, `objects/` and `renders/` stays on your computer: the repository ignores
the contents of these four folders.

## Limits

- It is a proof of concept for one user, and a work in progress. Expect rough edges.
- Hands and feet are neutral; there is no finger or toe posing yet.
- Twist and head rotation are approximate. Ground contact is by bone, so hair or hands can dip below the floor.
- New figures can only be drawn in the main front sketch.
- Objects do not show in the sketch views yet; they live in 3D.
- A GLTF that points to separate `.bin` or texture files cannot be read. Use a GLB or a self-contained GLTF.
- A stretched (non-uniform) character scale is handled approximately by the posing tools.
- Tested mainly in Chrome-based browsers and Firefox on Windows.
- No sample characters are included (see `models/README.md`); the mannequin always works.

## Building and testing

See `source/README.md` for building the page from the source and `source/tests/README.md` for the test suite.

## Licence

No licence yet: all rights reserved. You may look at the code and download it, but you may not reuse or
redistribute it until a licence is added.

## Credits

- [three.js](https://threejs.org) (MIT licence, copyright the three.js authors), included in `source/vendor/three/`
  together with its licence file.
- Built with [esbuild](https://esbuild.github.io), [TypeScript](https://www.typescriptlang.org) and
  [Playwright](https://playwright.dev) (build and test tools, not part of the page).
