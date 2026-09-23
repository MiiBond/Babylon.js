# WebGPU Ray Tracing — Design Notes

This document records architectural decisions and the remaining roadmap for the Babylon.js WebGPU ray tracer. It supplements the inline shader comments with higher-level context.

## Two rendering modes

### 1. Megakernel path tracer (`FrameGraphRayTracerTask`)
Full multi-bounce path tracer. Output is **linear HDR** `rgba16float`. Requires a `FrameGraphImageProcessingTask` downstream for tonemapping and sRGB conversion before display.

### 2. Rasterized hybrid with diffuse GI (`FrameGraphRtDiffuseGITask`)
Rasterizes the primary hit via Babylon's standard pipeline, then traces a single diffuse bounce per pixel to add indirect lighting. Composites through `rtDiffuseGIPluginMaterial` inside the existing OpenPBR fragment shader, so the standard image processing pipeline (tonemapping, sRGB) is applied automatically.

## Hybrid task composition

```
FrameGraphRtDiffuseGITask
  ├── FrameGraphGeometryRendererTask  →  G-buffer (depth + world-space normal)
  ├── Scene-change hash check         →  static-frame skip (no GPU work if scene is unchanged)
  └── FrameGraphRtGITraceTask         →  GI kernel dispatch
        rtGIKernelWgsl:
          1. Primary NEE: sample one emissive triangle directly from the primary hit.
             Captures oblique area lights that cosine-weighted bounce sampling misses.
             Contribution divided by π to stay in running-mean E/π units.
          2. Cosine-weighted diffuse bounce ray.
          3. On secondary hit:
             a. Secondary NEE (evalDirectLighting): 2-bounce emissive path.
             b. Secondary IBL ambient: envIrradiance × baseColor × (1−metalness) / π.
                This is the indirect env→secondary→primary path NOT present in rasterized IBL.
          4. On miss: zero. The rasterized IBL already provides env→primary (1st-bounce diffuse).
             Adding it here would double-count.
          5. Temporal accumulation: running average in giHistory (rgba32float).
             giOutput (rgba16float) = current blended value.
```

`rtDiffuseGIPluginMaterial` reads `giOutput` in the OpenPBR fragment shader and adds `irradiance × baseColor` to the diffuse term, completing the Lambertian BRDF: `L_o = (baseColor/π) × E_gi`.

## Running-mean scale invariant (E/π)

All values accumulated in `giHistory`/`irradiance` must be in units of **irradiance / π** (E/π), not raw irradiance E. This is because:

- Cosine-weighted sampling PDF = cos(θ)/π
- The importance-sampled estimator's running mean converges to E/π
- The plugin then multiplies by `baseColor`, yielding `L_o = baseColor × E/π = (baseColor/π) × E` — the correct Lambertian BRDF

Consequences:
- Primary NEE: `Le × NdotL × NdotLe × area × N / (dist² × π)`
- Secondary IBL ambient: `envIrradiance × baseColor × (1−metalness) / π`

## IBL rotation

`CubeTexture.rotationY` is wired through `FrameUniforms.iblRotation` (f32, replaces former `_padFU0` padding). All cubemap samples in both kernels must wrap the direction with `applyIblRotation()` from `rtCommonWgsl.ts`.

## Pending work

### 1. IBL contact shadows (highest impact on GI quality)
Add `FrameGraphIblShadowsRendererTask` alongside `FrameGraphRtDiffuseGITask`. This task can share the G-buffer via the public getters `gBufferDepthTexture` and `gBufferNormalTexture` on `FrameGraphRtDiffuseGITask`. The IBL shadow map is the main remaining difference between the GI hybrid and the reference megakernel.

### 2. Denoising pass
A spatial/temporal denoiser between the GI trace output and the composite step would allow reducing samples-per-frame. Not yet designed. The `giOutput` texture is the natural insertion point.

### 3. Multi-bounce (low priority / not planned)
The GI kernel is intentionally 1-bounce. Multi-bounce would require either the full megakernel or an iterative design (ping-pong GI kernel). No current plans.

## Known remaining gap vs. megakernel reference

The GI hybrid will always differ from the megakernel because:
1. Only 1 bounce (by design) vs. multi-bounce
2. No IBL contact shadows (pending item #1)

These are known limitations, not bugs.
