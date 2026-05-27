import { type FrameGraph } from "core/FrameGraph/frameGraph";
import { type FrameGraphTextureHandle, type FrameGraphTextureCreationOptions } from "core/FrameGraph/frameGraphTypes";
import { FrameGraphTask } from "core/FrameGraph/frameGraphTask";
import { ComputeShader } from "core/Compute/computeShader";
import { UniformBuffer } from "core/Materials/uniformBuffer";
import { ShaderStore } from "core/Engines/shaderStore";
import { Constants } from "core/Engines/constants";
import { Logger } from "core/Misc/logger";
import { type WebGPUEngine } from "core/Engines/webgpuEngine";
import { type Camera } from "core/Cameras/camera";
import { Matrix } from "core/Maths/math.vector";
import { type InternalTexture } from "core/Materials/Textures/internalTexture";
import { type BaseTexture } from "core/Materials/Textures/baseTexture";
import { RawTexture2DArray } from "core/Materials/Textures/rawTexture2DArray";
import { type RtGeometryManager } from "../geometry/rtGeometryManager";
import { type RtMaterialManager } from "../materials/rtMaterialManager";
import { type RtTextureManager } from "../materials/rtTextureManager";
import { type AbstractEngine } from "core/Engines/abstractEngine";
import { type Scene } from "core/scene";
import { GetOpenPBREnvironmentBRDFTexture } from "core/Misc/brdfTextureTools";

// Register the megakernel WGSL source into the ShaderStore on first import.
// The source is split across three WGSL files that are embedded here as
// template strings; this keeps the shader out of any .js bundle and makes
// it easy to concatenate at load time.
import { RtCommonWgsl } from "../shaders/rtCommonWgsl";
import { RtUserHooksWgsl } from "../shaders/rtUserHooksWgsl";
import { RtBsdfWgsl } from "../shaders/rtBsdfWgsl";
import { RtMegakernelWgsl } from "../shaders/rtMegakernelWgsl";

const RtShaderName = "rtMegakernel";

if (!ShaderStore.ShadersStoreWGSL[`${RtShaderName}ComputeShader`]) {
    // Concatenate common structs + default user hooks + BSDF library + megakernel body.
    // Order matters: rtCommon declares types, rtUserHooks provides override stubs,
    // rtBsdf provides sampleSurface/evalIblShading, rtMegakernel is the entry point.
    ShaderStore.ShadersStoreWGSL[`${RtShaderName}ComputeShader`] = RtCommonWgsl + "\n" + RtUserHooksWgsl + "\n" + RtBsdfWgsl + "\n" + RtMegakernelWgsl;
}

/**
 * Options for the ray tracing task.
 */
export interface IFrameGraphRtRayTracingOptions {
    /** Output width in pixels */
    width: number;
    /** Output height in pixels */
    height: number;
    /** Maximum ray bounces per path (default: 4) */
    maxBounces: number;
}

/**
 * Frame graph task that dispatches the ray tracing megakernel and manages
 * progressive accumulation via a persistent rgba32float storage texture.
 * @internal
 */
export class FrameGraphRtRayTracingTask extends FrameGraphTask {
    private readonly _notSupported: boolean;
    private _cs: ComputeShader | null = null;
    private _frameUbo: UniformBuffer | null = null;
    private _options: IFrameGraphRtRayTracingOptions;
    private _sampleIndex = 0;
    private _geomMgr: RtGeometryManager | null = null;
    private _matMgr: RtMaterialManager | null = null;
    private _texMgr: RtTextureManager | null = null;
    /** Lazily-created 1×1×1 white 2D array texture — used when no texture manager is set. */
    private _fallbackTexArray: RawTexture2DArray | null = null;
    private readonly _invViewProjScratch = new Matrix();
    private _prevInvVpHash = 0;

    /** The accumulated + tone-mapped output texture handle */
    public readonly outputTexture: FrameGraphTextureHandle;
    /** The rgba32float accumulation texture handle (read_write, single buffer) */
    private _accumTexture?: FrameGraphTextureHandle;

    /** Set to true to reset the accumulation buffer on the next frame */
    public resetAccumulation = true; // start clean; hash check re-arms it each camera move

    /** Optional user-supplied processFinalCode callback for shader injection */
    public processFinalCode?: (code: string) => string;

    /** Camera used for ray generation — must be set before the first frame */
    public camera: Camera | null = null;

    // ---- Scene reference (for auto-resolving IBL each frame) ----------------
    private readonly _scene: Scene;

    /** Previous environmentTexture reference — used to detect scene IBL changes */
    private _prevEnvTex: BaseTexture | null = null;

    /** Cached BaseTexture shim wrapping engine.emptyCubeTexture (fallback when IBL is not set) */
    private _fallbackCubeTex: BaseTexture | null = null;
    /** Cached BaseTexture shim wrapping engine.emptyTexture (fallback when IBL is not set) */
    private _fallbackTex2d: BaseTexture | null = null;

    /**
     * Creates a new FrameGraphRtRayTracingTask.
     * @param name - Task name
     * @param frameGraph - The owning frame graph
     * @param scene - The scene to ray trace
     * @param options - Ray tracing configuration options
     */
    constructor(name: string, frameGraph: FrameGraph, scene: Scene, options: IFrameGraphRtRayTracingOptions) {
        super(name, frameGraph);
        this._scene = scene;
        this._options = { ...options };

        if (!frameGraph.engine.getCaps().supportComputeShaders) {
            this._notSupported = true;
            Logger.Error(`${name}: compute shaders are not supported (WebGPU required).`);
            this.outputTexture = this._frameGraph.textureManager.createDanglingHandle();
            return;
        }

        this._notSupported = false;
        this.outputTexture = this._frameGraph.textureManager.createDanglingHandle();

        this._createShader();
    }

    private _createShader(): void {
        const engine = this._frameGraph.engine as WebGPUEngine;

        // Apply processFinalCode directly to the WGSL source and register it under
        // a unique ShaderStore key.  We cannot rely on the ComputeShader constructor's
        // processFinalCode callback because Babylon.js invokes it synchronously during
        // construction — before the caller has had a chance to set processFinalCode via
        // addClosestHitShader() / setMissShader() / setRayGenShader().
        const baseSource = ShaderStore.ShadersStoreWGSL[`${RtShaderName}ComputeShader`];
        let shaderKey = RtShaderName;
        if (this.processFinalCode) {
            shaderKey = `${RtShaderName}_${this.name}`;
            ShaderStore.ShadersStoreWGSL[`${shaderKey}ComputeShader`] = this.processFinalCode(baseSource);
        }

        this._cs = new ComputeShader(
            `${this.name}_cs_${shaderKey}`,
            engine,
            { compute: shaderKey },
            {
                bindingsMapping: {
                    frame: { group: 0, binding: 0 },
                    bvhNodes: { group: 0, binding: 1 },
                    tlasInsts: { group: 0, binding: 2 },
                    triangles: { group: 0, binding: 3 },
                    attribs: { group: 0, binding: 4 },
                    materials: { group: 0, binding: 5 },
                    accumTex: { group: 0, binding: 6 },
                    outputTex: { group: 0, binding: 7 },
                    // IBL: binding 8 is the sampler (auto-inserted by setTexture(..., true))
                    envSpecular: { group: 0, binding: 9 },
                    envIrradiance: { group: 0, binding: 10 },
                    brdfLut: { group: 0, binding: 11 },
                    // Material texture array: binding 12 is the sampler (auto-inserted),
                    // binding 13 is the texture_2d_array itself.
                    texArray: { group: 0, binding: 13 },
                },
            }
        );

        // Frame uniforms: invViewProj(16) + camPos(3) + sampleIdx(1) + outputSize(2) + jitter(2) + maxBounces(1) + instanceCount(1) + pad(2)
        this._frameUbo = new UniformBuffer(engine);
        this._frameUbo.addUniform("invViewProj", 16);
        this._frameUbo.addUniform("cameraPosition", 3);
        this._frameUbo.addUniform("sampleIndex", 1);
        this._frameUbo.addUniform("outputSize", 2);
        this._frameUbo.addUniform("jitter", 2);
        this._frameUbo.addUniform("maxBounces", 1);
        this._frameUbo.addUniform("instanceCount", 1);
        this._frameUbo.addUniform("iblEnabled", 1);
        this._frameUbo.addUniform("iblMaxMip", 1);
        this._frameUbo.addUniform("iblLodScale", 1);

        this._cs.setUniformBuffer("frame", this._frameUbo);
    }

    /**
     * Rebuilds the compute shader with the current `processFinalCode` applied.
     * Call this after changing `processFinalCode` (e.g. after `addClosestHitShader`)
     * so the new WGSL is compiled before the first dispatch.
     */
    public rebuildShader(): void {
        if (this._notSupported) {
            return;
        }
        // Dispose old UBO; CS is left for GC (no public dispose on ComputeShader).
        this._frameUbo?.dispose();
        this._frameUbo = null;
        this._cs = null;
        this._createShader();
        // Reset accumulation so the first frame with the new shader starts clean.
        this.resetAccumulation = true;
    }

    /**
     * {@inheritDoc}
     * @returns The class name string
     */
    public override getClassName(): string {
        return "FrameGraphRtRayTracingTask";
    }

    /**
     * {@inheritDoc}
     * @returns True when the compute shader is ready to dispatch
     */
    public override isReady(): boolean {
        return this._notSupported ? true : (this._cs?.isReady() ?? false);
    }

    /**
     * Wire up geometry and material buffers from the BVH build task.
     * Stores a reference to `geomMgr` so the execute callback can read
     * the live `instanceCount` on every frame.
     * @param geomMgr The geometry manager owning the BVH and triangle buffers
     * @param matMgr The material manager owning the RTMaterial buffer
     */
    /**
     * Wire up geometry and material managers from the BVH build task.
     * Stores references so the execute callback can rebind the buffers
     * every frame — the geometry manager reallocates its StorageBuffers
     * when the scene grows, so bindings must be refreshed at runtime.
     * @param geomMgr The geometry manager owning the BVH and triangle buffers
     * @param matMgr The material manager owning the RTMaterial buffer
     */
    public setGeometryBuffers(geomMgr: RtGeometryManager, matMgr: RtMaterialManager): void {
        this._geomMgr = geomMgr;
        this._matMgr = matMgr;
        // Note: buffers are null at record() time (geometry hasn't been uploaded
        // yet).  Actual binding happens in the execute callback each frame.
    }

    /**
     * Wire up the texture manager.  The texture array is bound every frame; before
     * the first async upload completes it uses a 1×1 white fallback, which the shader
     * harmlessly ignores because all RTMaterial texture indices are NO_TEX (65535).
     * @param texMgr The texture manager owning the GPU texture array
     */
    public setTextureManager(texMgr: RtTextureManager): void {
        this._texMgr = texMgr;
    }

    /** {@inheritDoc} */
    public override record(): void {
        const textureManager = this._frameGraph.textureManager;
        const { width, height } = this._options;

        // Allocate / re-use the rgba32float accumulation texture.
        // Not a history texture: the WGSL uses read_write on a single texture,
        // so no frame-graph ping-pong is required.
        const accumOptions: FrameGraphTextureCreationOptions = {
            size: { width, height },
            sizeIsPercentage: false,
            isHistoryTexture: false,
            options: {
                createMipMaps: false,
                samples: 1,
                types: [Constants.TEXTURETYPE_FLOAT],
                formats: [Constants.TEXTUREFORMAT_RGBA],
                useSRGBBuffers: [false],
                creationFlags: [Constants.TEXTURE_CREATIONFLAG_STORAGE],
                labels: [`${this.name} Accum`],
            },
        };
        this._accumTexture = textureManager.createRenderTargetTexture(`${this.name} Accum`, accumOptions, this._accumTexture);

        // Output texture (rgba16float, write-only storage)
        const outputOptions: FrameGraphTextureCreationOptions = {
            size: { width, height },
            sizeIsPercentage: false,
            isHistoryTexture: false,
            options: {
                createMipMaps: false,
                samples: 1,
                types: [Constants.TEXTURETYPE_HALF_FLOAT],
                formats: [Constants.TEXTUREFORMAT_RGBA],
                useSRGBBuffers: [false],
                creationFlags: [Constants.TEXTURE_CREATIONFLAG_STORAGE],
                labels: [`${this.name} Output`],
            },
        };
        textureManager.resolveDanglingHandle(this.outputTexture, undefined, `${this.name} Output`, outputOptions);

        const pass = this._frameGraph.addPass(this.name);

        pass.setExecuteFunc((context) => {
            if (this._notSupported || !this._cs || !this._frameUbo) {
                return;
            }

            // Rebind geometry storage buffers every frame.
            // The geometry manager creates its StorageBuffers lazily on the
            // first frame and may reallocate them when the scene grows, so we
            // cannot bind them at record() time.  We also skip the dispatch
            // entirely when the scene is empty (all buffers are null) so that
            // WebGPU never sees an incomplete bind group.
            const geomMgr = this._geomMgr;
            const matMgr = this._matMgr;
            if (!geomMgr?.bvhNodeBuffer || !geomMgr.tlasBuffer || !geomMgr.triangleBuffer || !geomMgr.attribBuffer || !matMgr?.buffer) {
                return;
            }
            this._cs.setStorageBuffer("bvhNodes", geomMgr.bvhNodeBuffer);
            this._cs.setStorageBuffer("tlasInsts", geomMgr.tlasBuffer);
            this._cs.setStorageBuffer("triangles", geomMgr.triangleBuffer);
            this._cs.setStorageBuffer("attribs", geomMgr.attribBuffer);
            this._cs.setStorageBuffer("materials", matMgr.buffer);

            // Update camera-derived uniforms and detect movement for accumulation reset
            if (this.camera) {
                this.camera.getTransformationMatrix().invertToRef(this._invViewProjScratch);
                const hash = this._hashMatrix(this._invViewProjScratch);
                if (hash !== this._prevInvVpHash) {
                    this.resetAccumulation = true;
                    this._prevInvVpHash = hash;
                }
            }

            const sampleIdx = this.resetAccumulation ? 0 : this._sampleIndex;
            this.resetAccumulation = false;
            this._sampleIndex = sampleIdx + 1;

            // Update UBO
            this._frameUbo!.updateMatrix("invViewProj", this._invViewProjScratch);
            if (this.camera) {
                const p = this.camera.position;
                this._frameUbo!.updateFloat3("cameraPosition", p.x, p.y, p.z, "");
            }
            this._frameUbo!.updateUInt("sampleIndex", sampleIdx);
            this._frameUbo!.updateFloat2("outputSize", width, height, "");
            // Suppress jitter on the first sample of each accumulation run (sampleIdx == 0).
            // While the camera is moving every frame resets to sampleIdx=0, so jitter would
            // produce a different subpixel ray each frame and cause the geometry to visibly swim.
            // Once samples start accumulating (sampleIdx > 0) jitter is restored for AA.
            const jx = sampleIdx === 0 ? 0 : Math.random() - 0.5;
            const jy = sampleIdx === 0 ? 0 : Math.random() - 0.5;
            this._frameUbo!.updateFloat2("jitter", jx, jy, "");
            this._frameUbo!.updateUInt("maxBounces", this._options.maxBounces);
            this._frameUbo!.updateUInt("instanceCount", this._geomMgr?.instanceCount ?? 0);

            // ---- Auto-resolve IBL from the scene each frame -----------------
            // scene.environmentTexture holds the prefiltered specular cubemap.
            // Its irradianceTexture property holds the diffuse irradiance cubemap.
            // GetOpenPBREnvironmentBRDFTexture loads the BRDF LUT once and caches
            // it on the scene as scene.openPBREnvironmentBRDFTexture.
            const envTex = this._scene.environmentTexture;
            const irradianceTex = envTex?.irradianceTexture ?? null;
            const brdfLut = GetOpenPBREnvironmentBRDFTexture(this._scene);
            const hasIbl = !!(envTex && irradianceTex && brdfLut?.isReady());

            // Reset accumulation when the environment changes (e.g. user swaps IBL).
            if (envTex !== this._prevEnvTex) {
                this.resetAccumulation = true;
                this._prevEnvTex = envTex;
            }

            this._frameUbo!.updateUInt("iblEnabled", hasIbl ? 1 : 0);

            // Prefiltered-specular mip parameters for getLodFromAlphaG-matching formula:
            //   specMip = iblMaxMip + log2(max(alphaG, ε)) * iblLodScale
            // where alphaG = roughness².  This mirrors what the rasterizer does:
            //   reflectionLOD = log2(dim * alphaG) * lodScale
            //                 = log2(dim)*lodScale + log2(alphaG)*lodScale
            //                 = iblMaxMip + log2(alphaG) * iblLodScale
            // For a smooth surface (roughness→0) this gives ~mip 0 (sharp reflection);
            // for a rough surface (roughness→1) it gives iblMaxMip (most blurred).
            let iblMaxMip = 1.0;
            let iblLodScale = 1.0;
            if (hasIbl && envTex) {
                const texSize = envTex.getSize();
                const maxDim = Math.max(texSize.width, texSize.height, 1);
                const lodScale = envTex.lodGenerationScale || 1.0;
                iblMaxMip = Math.log2(maxDim) * lodScale;
                iblLodScale = lodScale;
            }
            this._frameUbo!.updateFloat("iblMaxMip", iblMaxMip);
            this._frameUbo!.updateFloat("iblLodScale", iblLodScale);
            this._frameUbo!.update();

            // Bind storage textures — resolved fresh each frame from the frame graph
            // handle system.  getTextureFromHandle returns InternalTexture; we wrap it
            // in a minimal shim so setStorageTexture (which expects BaseTexture) can
            // access the underlying hardware texture view.
            const accumInternal = context.getTextureFromHandle(this._accumTexture!);
            const outputInternal = context.getTextureFromHandle(this.outputTexture);
            if (accumInternal) {
                this._cs!.setStorageTexture("accumTex", this._wrapInternal(accumInternal, `${this.name}_accum`));
            }
            if (outputInternal) {
                this._cs!.setStorageTexture("outputTex", this._wrapInternal(outputInternal, `${this.name}_output`));
            }

            // Bind IBL sampled textures — WebGPU requires all declared bindings to be
            // present even when iblEnabled == 0, so we fall back to engine-provided
            // empty (1 × 1) textures when no real IBL data has been supplied.
            const eng = this._frameGraph.engine as unknown as AbstractEngine;
            if (!this._fallbackCubeTex) {
                this._fallbackCubeTex = this._wrapInternal(eng.emptyCubeTexture, "rt_empty_cube");
            }
            if (!this._fallbackTex2d) {
                this._fallbackTex2d = this._wrapInternal(eng.emptyTexture, "rt_empty_2d");
            }

            if (hasIbl) {
                // bindSampler=true  → Babylon auto-inserts the sampler at binding 8
                this._cs!.setTexture("envSpecular", envTex!);
                // bindSampler=false → reuse the sampler already bound by envSpecular
                this._cs!.setTexture("envIrradiance", irradianceTex!, false);
                this._cs!.setTexture("brdfLut", brdfLut!, false);
            } else {
                this._cs!.setTexture("envSpecular", this._fallbackCubeTex);
                this._cs!.setTexture("envIrradiance", this._fallbackCubeTex, false);
                this._cs!.setTexture("brdfLut", this._fallbackTex2d, false);
            }

            // Bind the material texture array (binding 13; sampler auto-inserted at 12).
            // RtTextureManager.textureArray always returns a valid texture_2d_array
            // (falls back to a 1×1×1 white placeholder until the async upload completes).
            // If no texture manager was wired up, create a minimal fallback on demand so
            // the WebGPU bind group is always complete.
            if (this._texMgr) {
                this._cs!.setTexture("texArray", this._texMgr.textureArray);
            } else {
                if (!this._fallbackTexArray) {
                    const white = new Uint8Array([255, 255, 255, 255]);
                    this._fallbackTexArray = new RawTexture2DArray(white, 1, 1, 1, Constants.TEXTUREFORMAT_RGBA, this._scene, false, false, Constants.TEXTURE_LINEAR_LINEAR);
                }
                this._cs!.setTexture("texArray", this._fallbackTexArray);
            }

            const dispatchX = Math.ceil(width / 8);
            const dispatchY = Math.ceil(height / 8);

            context.pushDebugGroup(`RT Megakernel dispatch (${this.name})`);
            this._cs!.dispatch(dispatchX, dispatchY, 1);
            context.popDebugGroup();
        });
    }

    /** {@inheritDoc} */
    public override dispose(): void {
        this._frameUbo?.dispose();
        this._fallbackTexArray?.dispose();
        this._frameUbo = null;
        this._fallbackTexArray = null;
        this._cs = null;
        this._geomMgr = null;
        this._matMgr = null;
        this._texMgr = null;
        super.dispose();
    }

    /**
     * Wraps a raw `InternalTexture` in the minimal shim that
     * `ComputeShader.setStorageTexture` (and the underlying WebGPU dispatch)
     * actually reads at runtime:
     *  - `._texture` — the InternalTexture with its hardware texture view
     *  - `.isReady()` — signals the binding is valid
     *  - `.name` / `.uniqueId` — used in error logging
     *
     * The cast via `unknown` is intentional: the frame graph only exposes
     * `InternalTexture` from handles, while the `BaseTexture` wrapper type is
     * not constructable without a scene reference.
     * @param internal The InternalTexture to wrap
     * @param name Debug name for the texture
     * @returns A BaseTexture-compatible shim
     */
    private _wrapInternal(internal: InternalTexture, name: string): BaseTexture {
        return { _texture: internal, isReady: () => true, name, uniqueId: internal.uniqueId } as unknown as BaseTexture;
    }

    /**
     * FNV-1a rolling hash over the 16 floats of a mat4 to detect camera movement.
     * Not cryptographic — just fast change detection.
     * @param mat The matrix to hash
     * @returns 32-bit hash value
     */
    private _hashMatrix(mat: Matrix): number {
        const m = mat.m;
        let h = 0x811c9dc5;
        for (let i = 0; i < 16; i++) {
            const bits = new Uint32Array(new Float32Array([m[i]]).buffer)[0];
            h ^= bits;
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h;
    }
}
