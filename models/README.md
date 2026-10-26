# models/

Put your own rigged humanoid characters here (GLB or VRM). Everything in this folder is listed in the character
menu at the top left of the 3D viewport. The built-in mannequin needs no files, and none are included in this
repository.

Loading a character from elsewhere (through the same menu) offers to keep a copy here. The contents of this folder
are never committed to the repository.

VRM files declare their bones; other files are matched by bone name (Mixamo, VRoid, Blender `.L`/`.R`, Unreal-style
and similar). If a bone is missed, fix it under Character, "Bone mapping".

## Optional sample characters for the full test suite

The test suite also checks posing on a few real characters when they are present. Without them those checks are
skipped. If you want to run them, put these files in this folder under these names:

| File | Rig | Where to get it |
|---|---|---|
| `Xbot.glb` | Mixamo | The three.js repository, `examples/models/gltf/Xbot.glb` |
| `Soldier.glb` | Mixamo | The three.js repository, `examples/models/gltf/Soldier.glb` |
| `Michelle.glb` | Mixamo | The three.js repository, `examples/models/gltf/Michelle.glb` |
| `VRM1_Constraint_Twist_Sample.vrm` | VRM 1.0 | The three-vrm repository, `packages/three-vrm/examples/models/` |

These belong to their respective owners and are not redistributed here; check their terms before reusing them.
