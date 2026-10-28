# Original map extraction

These self-written scripts read an installed copy of Boomerang Fu. They reconstruct the map catalogue, transforms, collider shapes and serialized mechanism parameters without executing the game. They are kept in version control so `src/core/original-map-data.json` can be regenerated and reviewed.

The supported input is the inspected Steam build `20430461`, Unity `2022.3.62f2`. The default installation data directory is `F:\SteamLibrary\steamapps\common\Boomerang Fu\Boomerang Fu_Data`; change the `DATA` constant in the exporter and optional preview extractor for another location. A different build needs a fresh schema and source-identity review, particularly the native MonoBehaviour header alignment and the player-prefab reference. Source hashes and extraction scope are documented in `docs/original-map-inventory.md`.

Use Python 3.11 or newer with UnityPy `1.23.0`, TypeTreeGeneratorAPI `0.0.10`, and Pillow. The scripts use `tools/python` and `analysis/derived/v5-tools` when present, then normal Python import paths. These local dependencies are ignored by Git. One way to prepare an isolated project dependency folder is:

```powershell
python -m pip install --target tools/python UnityPy==1.23.0 TypeTreeGeneratorAPI==0.0.10 Pillow
```

Run from the repository root, in this order:

```powershell
python scripts/research/export-original-maps.py
python scripts/research/inventory-original-level-assets.py
python scripts/research/convert-original-maps.py
python scripts/research/validate-original-maps.py
python scripts/research/verify-original-height-evidence.py
python scripts/research/write-original-map-inventory.py
```

The exporter writes full local evidence to ignored `analysis/derived/v5-maps/`, including inactive objects, native object source offsets, complete MonoBehaviour raw bytes, and mesh/submesh bounds. The inventory scans all top-level `.assets` files to check whether any LevelAsset is missing from the level manager. The converter writes only scalar geometry, rule instances and source identifiers into production JSON. It does not copy meshes, textures, sounds, executable bytes or decompiled source.

To check reproducibility after extraction without changing the production JSON or conversion report:

```powershell
python scripts/research/convert-original-maps.py --check
```

`export-original-map-previews.py` is optional. It extracts the 57 original preview PNGs and a contact sheet into the same ignored analysis directory for local comparison. Those images are excluded from the Web package. The tutorial has no source preview sprite.

Validation checks all 58 independent maps, six source spawns per map, all collider contour transformations, mechanism ownership and targets, portal exits, source layers, moving-floor rotation angles, and static-batch submesh ranges. `verify-original-height-evidence.py` independently compares one problematic combined-mesh pole's selected submesh AABB with its 172 original vertex positions, retaining only numerical bounds in its evidence output. These checks validate extraction and conversion; they do not establish original-game runtime parity or Web frame rate.
