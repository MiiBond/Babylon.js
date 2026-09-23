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
import { RtCommonWgsl } from "../shaders/rtCommonWgsl";
import { RtBsdfWgsl } from "../shaders/rtBsdfWgsl";
import { RtTraversalWgsl } from "../shaders/rtTraversalWgsl";
import { RtGIKernelWgsl } from "../shaders/rtGIKernelWgsl";

const RtGIShaderName = "rtGIKernel";

if (!ShaderStore.ShadersStoreWGSL[`${RtGIShaderName}ComputeShader`]) {
    // No user hooks: RtCommonWgsl + RtBsdfWgsl + RtTraversalWgsl + GI entry point.
    ShaderStore.ShadersStoreWGSL[`${RtGIShaderName}ComputeShader`] = RtCommonWgsl + "\n" + RtBsdfWgsl + "\n" + RtTraversalWgsl + "\n" + RtGIKernelWgsl;
}

/**
 * Options for the GI trace task.
 * @internal
 */
export interface IFrameGraphRtGITraceOptions {
    /** Output width in pixels (already scaled by resolutionScale) */
    width: number;
    /** Output height in pixels (already scaled by resolutionScale) */
    height: number;
    /** Full-resolution render target width — needed for G-buffer UV mapping */
    fullWidth: number;
    /** Full-resolution render target height */
    fullHeight: number;
}

/**
 * Frame graph compute task that traces single-bounce diffuse rays from a
 * rasterized G-buffer and accumulates the irradiance over frames.
 *
 * The output is a half-resolution (or configurable) RGBA16F irradiance texture
 * containing raw incoming irradiance (not yet multiplied by surface albedo).
 * `RtDiffuseGIPluginMaterial` handles the albedo weighting inside OpenPBR.
 * @internal
 */
export class FrameGraphRtGITraceTask extends FrameGraphTask {
    private readonly _notSupported: boolean;
    private _cs: ComputeShader | null = null;
    private _frameUbo: UniformBuffer | null = null;
    private _giExtraUbo: UniformBuffer | null = null;
    private _options: IFrameGraphRtGITraceOptions;
    private _sampleIndex = 0;
    private _geomMgr: RtGeometryManager | null = null;
    private _matMgr: RtMaterialManager | null = null;
    private _texMgr: RtTextureManager | null = null;
    private _fallbackTexArray: RawTexture2DArray | null = null;
    private readonly _invViewProjScratch = new Matrix();
    private _prevInvVpHash = 0;

    /** G-buffer depth texture handle — must be set before record(). */
    public depthTexture: FrameGraphTextureHandle | undefined;
    /** G-buffer world-normal texture handle — must be set before record(). */
    public normalTexture: FrameGraphTextureHandle | undefined;

    /** Camera used for world-position reconstruction — must be set before first frame. */
    public camera: Camera | null = null;

    /** Set to true to force a sample-count reset on the next frame. */
    public resetAccumulation = true;

    /** Accumulated irradiance output (half-resolution RGBA16F). */
    public readonly outputTexture: FrameGraphTextureHandle;

    /** Internal rgba32float history buffer (read_write, single in-place accumulation). */
    private _historyTexture?: FrameGraphTextureHandle;

    private readonly _scene: Scene;
    private _prevEnvTex: BaseTexture | null = null;
    private _fallbackCubeTex: BaseTexture | null = null;

    /**
     * Creates a new FrameGraphRtGITraceTask.
     * @param name - Task name
     * @param frameGraph - The owning frame graph
     * @param scene - The scene whose BVH/materials will be queried
     * @param options - Resolution and layout options
     */
    constructor(name: string, frameGraph: FrameGraph, scene: Scene, options: IFrameGraphRtGITraceOptions) {
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

        this._cs = new ComputeShader(
            `${this.name}_gi_cs`,
            engine,
            { compute: RtGIShaderName },
            {
                bindingsMapping: {
                    frame: { group: 0, binding: 0 },
                    bvhNodes: { group: 0, binding: 1 },
                    tlasInsts: { group: 0, binding: 2 },
                    triangles: { group: 0, binding: 3 },
                    attribs: { group: 0, binding: 4 },
                    materials: { group: 0, binding: 5 },
                    giHistory: { group: 0, binding: 6 },
                    giOutput: { group: 0, binding: 7 },
                    // Binding 9 is envSampler (auto-inserted by setTexture("envIrradiance", ..., true))
                    envIrradiance: { group: 0, binding: 10 },
                    // Binding 12 is texSampler (auto-inserted by setTexture("texArray", tex, true))
                    texArray: { group: 0, binding: 13 },
                    emissiveTris: { group: 0, binding: 14 },
                    depthTex: { group: 0, binding: 15 },
                    normalTex: { group: 0, binding: 16 },
                    giExtra: { group: 0, binding: 17 },
                },
            }
        );

        // FrameUniforms UBO — same layout as the megakernel.
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
        this._frameUbo.addUniform("emissiveCount", 1);
        this._frameUbo.addUniform("_padFU0", 1);
        this._frameUbo.addUniform("_padFU1", 1);
        this._cs.setUniformBuffer("frame", this._frameUbo);

        // GIExtraUniforms UBO — fullOutputSize + giOutputSize.
        this._giExtraUbo = new UniformBuffer(engine);
        this._giExtraUbo.addUniform("fullOutputSize", 2);
        this._giExtraUbo.addUniform("giOutputSize", 2);
        this._cs.setUniformBuffer("giExtra", this._giExtraUbo);
    }

    /** @inheritDoc */
    public override getClassName(): string {
        return "FrameGraphRtGITraceTask";
    }

    /** @inheritDoc */
    public override isReady(): boolean {
        return this._notSupported ? true : (this._cs?.isReady() ?? false);
    }

    /**
     * Wire up geometry and material managers from the BVH build task.
     * @param geomMgr The geometry manager owning the BVH and triangle buffers
     * @param matMgr  The material manager owning the RTMaterial buffer
     */
    public setGeometryBuffers(geomMgr: RtGeometryManager, matMgr: RtMaterialManager): void {
        this._geomMgr = geomMgr;
        this._matMgr = matMgr;
    }

    /**
     * Wire up the material texture manager.
     * @param texMgr The texture manager owning the GPU texture array
     */
    public setTextureManager(texMgr: RtTextureManager): void {
        this._texMgr = texMgr;
    }

    /** @inheritDoc */
    public override record(): void {
        const textureManager = this._frameGraph.textureManager;
        const { width, height } = this._options;

        // In-place rgba32float history (read_write, NOT a history texture — we manage
        // accumulation manually using frame.sampleIndex, same as the megakernel).
        const historyOptions: FrameGraphTextureCreationOptions = {
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
                labels: [`${this.name} GI History`],
            },
        };
        this._historyTexture = textureManager.createRenderTargetTexture(`${this.name} GI History`, historyOptions, this._historyTexture);

        // Output texture (rgba16float, write-only).
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
                labels: [`${this.name} GI Output`],
            },
        };
        textureManager.resolveDanglingHandle(this.outputTexture, undefined, `${this.name} GI Output`, outputOptions);

        const pass = this._frameGraph.addPass(this.name);

        pass.setExecuteFunc((context) => {
            if (this._notSupported || !this._cs || !this._frameUbo || !this._giExtraUbo) {
                return;
            }

            // Require both geometry managers and the G-buffer inputs.
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

            if (geomMgr.emissiveBuffer) {
                this._cs.setStorageBuffer("emissiveTris", geomMgr.emissiveBuffer);
            }

            // Camera-move detection: hash invViewProj and reset accumulation on change.
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

            // Update FrameUniforms.
            this._frameUbo!.updateMatrix("invViewProj", this._invViewProjScratch);
            if (this.camera) {
                const p = this.camera.position;
                this._frameUbo!.updateFloat3("cameraPosition", p.x, p.y, p.z, "");
            }
            this._frameUbo!.updateUInt("sampleIndex", sampleIdx);
            this._frameUbo!.updateFloat2("outputSize", width, height, "");
            this._frameUbo!.updateFloat2("jitter", 0, 0, ""); // GI kernel does not use jitter
            this._frameUbo!.updateUInt("maxBounces", 1); // single bounce
            this._frameUbo!.updateUInt("instanceCount", geomMgr.instanceCount ?? 0);

            // IBL resolution — GI kernel only needs the diffuse irradiance cube.
            const envTex = this._scene.environmentTexture;
            const irradianceTex = envTex?.irradianceTexture ?? null;
            const hasIbl = !!(envTex && irradianceTex);

            if (envTex !== this._prevEnvTex) {
                this.resetAccumulation = true;
                this._prevEnvTex = envTex;
            }

            this._frameUbo!.updateUInt("iblEnabled", hasIbl ? 1 : 0);

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
            this._frameUbo!.updateUInt("emissiveCount", geomMgr.emissiveCount ?? 0);
            this._frameUbo!.updateUInt("_padFU0", 0);
            this._frameUbo!.updateUInt("_padFU1", 0);
            this._frameUbo!.update();

            // Update GIExtraUniforms.
            this._giExtraUbo!.updateFloat2("fullOutputSize", this._options.fullWidth, this._options.fullHeight, "");
            this._giExtraUbo!.updateFloat2("giOutputSize", width, height, "");
            this._giExtraUbo!.update();

            // Bind storage textures.
            const historyInternal = context.getTextureFromHandle(this._historyTexture!);
            const outputInternal = context.getTextureFromHandle(this.outputTexture);
            if (historyInternal) {
                this._cs!.setStorageTexture("giHistory", this._wrapInternal(historyInternal, `${this.name}_gi_history`));
            }
            if (outputInternal) {
                this._cs!.setStorageTexture("giOutput", this._wrapInternal(outputInternal, `${this.name}_gi_output`));
            }

            // Bind G-buffer textures (depth + normal) as sampled textures.
            if (this.depthTexture !== undefined) {
                const depthInternal = context.getTextureFromHandle(this.depthTexture);
                if (depthInternal) {
                    this._cs!.setTexture("depthTex", this._wrapInternal(depthInternal, `${this.name}_depth`), false);
                }
            }
            if (this.normalTexture !== undefined) {
                const normalInternal = context.getTextureFromHandle(this.normalTexture);
                if (normalInternal) {
                    this._cs!.setTexture("normalTex", this._wrapInternal(normalInternal, `${this.name}_normal`), false);
                }
            }

            // Bind IBL irradiance cube (with sampler — auto-inserts envSampler at binding 9).
            const eng = this._frameGraph.engine as unknown as AbstractEngine;
            if (!this._fallbackCubeTex) {
                this._fallbackCubeTex = this._wrapInternal(eng.emptyCubeTexture, "gi_empty_cube");
            }

            this._cs!.setTexture("envIrradiance", hasIbl ? irradianceTex! : this._fallbackCubeTex, true);

            // Material texture array.
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

            context.pushDebugGroup(`RT Diffuse GI dispatch (${this.name})`);
            this._cs!.dispatch(dispatchX, dispatchY, 1);
            context.popDebugGroup();
        });
    }

    /** @inheritDoc */
    public override dispose(): void {
        this._frameUbo?.dispose();
        this._giExtraUbo?.dispose();
        this._fallbackTexArray?.dispose();
        this._frameUbo = null;
        this._giExtraUbo = null;
        this._fallbackTexArray = null;
        this._fallbackCubeTex = null;
        this._cs = null;
        this._geomMgr = null;
        this._matMgr = null;
        this._texMgr = null;
        super.dispose();
    }

    private _wrapInternal(internal: InternalTexture, name: string): BaseTexture {
        return { _texture: internal, isReady: () => true, name, uniqueId: internal.uniqueId } as unknown as BaseTexture;
    }

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
