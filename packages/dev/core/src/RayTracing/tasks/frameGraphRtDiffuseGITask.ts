import { type FrameGraph } from "core/FrameGraph/frameGraph";
import { type FrameGraphTextureHandle, type IFrameGraphPass } from "core/FrameGraph/frameGraphTypes";
import { FrameGraphTask } from "core/FrameGraph/frameGraphTask";
import { type Scene } from "core/scene";
import { type Camera } from "core/Cameras/camera";
import { type Material } from "core/Materials/material";
import { type Observer } from "core/Misc/observable";
import { Logger } from "core/Misc/logger";
import { Constants } from "core/Engines/constants";
import { FrameGraphGeometryRendererTask } from "core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { type FrameGraphObjectList } from "core/FrameGraph/frameGraphObjectList";
import { FrameGraphRtBvhBuildTask } from "./frameGraphRtBvhBuildTask";
import { FrameGraphRtGITraceTask } from "./frameGraphRtGITraceTask";
import { RtDiffuseGIPluginMaterial } from "../materials/rtDiffuseGIPluginMaterial";

/**
 * Options for the diffuse GI task.
 */
export interface IFrameGraphRtDiffuseGIOptions {
    /**
     * Full-resolution output width in pixels.
     * The GI kernel runs at `resolutionScale × width`.
     */
    width: number;
    /**
     * Full-resolution output height in pixels.
     * The GI kernel runs at `resolutionScale × height`.
     */
    height: number;
    /**
     * Fraction of the full resolution at which to trace GI rays.
     * Must be in `(0, 1]`; defaults to `0.5` (half resolution).
     * Values below `0.25` may produce visible blocky artefacts without
     * a bilateral upsampling step.
     */
    resolutionScale?: number;
}

/**
 * Composite frame graph task that traces single-bounce diffuse GI rays from a
 * rasterized G-buffer and composites the result into the scene via the
 * `RtDiffuseGIPluginMaterial` OpenPBR material plugin.
 *
 * The pipeline each frame:
 *  1. **Scene check pass** — hashes mesh positions + camera matrix O(mesh count).
 *     When nothing has changed the G-buffer render is skipped (passes' disabled
 *     flags are set here before they execute in the same frame loop).
 *  2. **G-buffer render** (managed internally) — renders full-res depth + world
 *     normals.  Skipped on static frames.
 *  3. `FrameGraphRtBvhBuildTask` — uploads scene geometry + materials to GPU.
 *  4. `FrameGraphRtGITraceTask` — traces one diffuse bounce per pixel at
 *     `resolutionScale` resolution, accumulates over frames.
 *  5. **Plugin-update pass** — wires the GI output texture to all scene materials
 *     so the raster pass receives the irradiance.
 *
 * Usage:
 * ```typescript
 * const giTask = new FrameGraphRtDiffuseGITask("DiffuseGI", frameGraph, scene, {
 *     width: 1920, height: 1080, resolutionScale: 0.5,
 * });
 * giTask.camera = camera;
 * giTask.record();
 * // The raster pass now receives GI automatically via the plugin.
 * // No separate G-buffer task setup is required.
 * ```
 */
export class FrameGraphRtDiffuseGITask extends FrameGraphTask {
    private readonly _bvhTask: FrameGraphRtBvhBuildTask;
    private readonly _giTraceTask: FrameGraphRtGITraceTask;
    private readonly _notSupported: boolean;
    private readonly _scene: Scene;
    private readonly _screenWidth: number;
    private readonly _screenHeight: number;
    private readonly _giWidth: number;
    private readonly _giHeight: number;

    /** Registered plugins on scene materials (kept for cleanup on dispose). */
    private readonly _plugins: RtDiffuseGIPluginMaterial[] = [];
    /** Observer that registers the plugin on newly-added materials. */
    private _materialAddedObserver: Observer<Material> | null = null;

    /**
     * Optional explicit object list for the internal G-buffer render.
     * If not set, all scene meshes are rendered into the G-buffer.
     */
    public objectList: FrameGraphObjectList | undefined;

    // ---- Internal G-buffer state --------------------------------------------

    /** Internal geometry renderer (created in record()). */
    private _geoTask: FrameGraphGeometryRendererTask | null = null;
    /** Passes belonging to the internal geometry renderer (captured in record()). */
    private _geoPasses: IFrameGraphPass[] = [];
    /** Combined scene+camera hash from the previous frame. */
    private _sceneAndCameraHash = 0;

    // ---- Name propagation ---------------------------------------------------

    public override get name() {
        return this._name;
    }

    public override set name(value: string) {
        this._name = value;
        if (this._bvhTask) {
            this._bvhTask.name = `${value} BVH Build`;
        }
        if (this._giTraceTask) {
            this._giTraceTask.name = `${value} GI Trace`;
        }
        if (this._geoTask) {
            this._geoTask.name = `${value} GBuffer`;
        }
    }

    // ---- Disabled propagation -----------------------------------------------

    public override get disabled() {
        return this._disabled;
    }

    public override set disabled(value: boolean) {
        this._disabled = value;
        if (this._bvhTask) {
            this._bvhTask.disabled = value;
        }
        if (this._giTraceTask) {
            this._giTraceTask.disabled = value;
            if (!value) {
                this._giTraceTask.resetAccumulation = true;
            }
        }
        // Disable/enable the GI contribution on all registered plugins.
        for (const plugin of this._plugins) {
            plugin.isEnabled = !value;
        }
    }

    // ---- Camera wiring ------------------------------------------------------

    /** Camera used for invViewProj reconstruction of G-buffer world positions. */
    public get camera(): Camera | null {
        return this._giTraceTask?.camera ?? null;
    }

    public set camera(value: Camera | null) {
        if (this._giTraceTask) {
            this._giTraceTask.camera = value;
        }
        if (this._geoTask && value) {
            this._geoTask.camera = value;
        }
    }

    // ---- G-buffer outputs (shared with other tasks) -------------------------

    /**
     * Screen-space depth texture produced by the internal G-buffer render.
     * Available after `record()`.  Can be wired to other tasks that need the
     * same G-buffer (e.g. IBL shadows) to avoid a second geometry render pass.
     */
    public get gBufferDepthTexture(): FrameGraphTextureHandle | undefined {
        return this._geoTask?.geometryScreenDepthTexture;
    }

    /**
     * World-space normal texture produced by the internal G-buffer render.
     * Available after `record()`.  Can be wired to other tasks that need the
     * same G-buffer (e.g. IBL shadows) to avoid a second geometry render pass.
     */
    public get gBufferNormalTexture(): FrameGraphTextureHandle | undefined {
        return this._geoTask?.geometryWorldNormalTexture;
    }

    // ---- Output texture -----------------------------------------------------

    /**
     * The GI irradiance texture (half-resolution RGBA16F).
     * Consumed internally by `RtDiffuseGIPluginMaterial`; exposed here for debugging.
     */
    public get outputTexture(): FrameGraphTextureHandle {
        return this._giTraceTask.outputTexture;
    }

    // ---- Constructor --------------------------------------------------------

    /**
     * Creates a new FrameGraphRtDiffuseGITask.
     * @param name - Task name
     * @param frameGraph - The owning frame graph
     * @param scene - The scene whose geometry and materials will be used
     * @param options - Resolution and configuration options
     */
    constructor(name: string, frameGraph: FrameGraph, scene: Scene, options: IFrameGraphRtDiffuseGIOptions) {
        super(name, frameGraph);

        this._scene = scene;

        if (!frameGraph.engine.getCaps().supportComputeShaders) {
            this._notSupported = true;
            Logger.Warn(`${name}: WebGPU with compute shader support is required for diffuse GI. Task is disabled.`);
            this._bvhTask = null!;
            this._giTraceTask = null!;
            this._screenWidth = 0;
            this._screenHeight = 0;
            this._giWidth = 0;
            this._giHeight = 0;
            return;
        }

        this._notSupported = false;

        this._screenWidth = options.width;
        this._screenHeight = options.height;
        const scale = Math.min(1, Math.max(0.01, options.resolutionScale ?? 0.5));
        this._giWidth = Math.max(1, Math.floor(options.width * scale));
        this._giHeight = Math.max(1, Math.floor(options.height * scale));

        this._bvhTask = new FrameGraphRtBvhBuildTask(`${name} BVH Build`, frameGraph, scene);
        this._giTraceTask = new FrameGraphRtGITraceTask(`${name} GI Trace`, frameGraph, scene, {
            width: this._giWidth,
            height: this._giHeight,
            fullWidth: options.width,
            fullHeight: options.height,
        });

        // Register the plugin on all currently present materials and subscribe
        // to the observable so future materials also receive it.
        for (const mat of scene.materials) {
            this._registerPlugin(mat);
        }
        this._materialAddedObserver = scene.onNewMaterialAddedObservable.add((mat) => {
            this._registerPlugin(mat);
        });
    }

    /** @inheritDoc */
    public override getClassName(): string {
        return "FrameGraphRtDiffuseGITask";
    }

    /** @inheritDoc */
    public override isReady(): boolean {
        if (this._notSupported) {
            return true;
        }
        return this._bvhTask.isReady() && this._giTraceTask.isReady();
    }

    /** @inheritDoc */
    public override record(): void {
        if (this._notSupported) {
            return;
        }

        const camera = this._giTraceTask.camera;
        if (!camera) {
            throw new Error(`${this.name}: camera must be set before record() is called.`);
        }

        // ---- Internal G-buffer geometry renderer ----------------------------
        // Build the G-buffer (screen-space depth + world normals) as a child
        // pass of this task.  Because record() is called while _currentProcessedTask
        // equals this task, all passes added by _geoTask.record() are appended to
        // our own _passes array and execute in document order alongside the other passes.

        this._geoTask = new FrameGraphGeometryRendererTask(`${this.name} GBuffer`, this._frameGraph, this._scene);
        this._geoTask.camera = camera;
        this._geoTask.size = { width: this._screenWidth, height: this._screenHeight };
        this._geoTask.sizeIsPercentage = false;
        this._geoTask.objectList = this.objectList ?? { meshes: this._scene.meshes, particleSystems: null };
        this._geoTask.textureDescriptions = [
            {
                type: Constants.PREPASS_SCREENSPACE_DEPTH_TEXTURE_TYPE,
                textureType: Constants.TEXTURETYPE_HALF_FLOAT,
                textureFormat: Constants.TEXTUREFORMAT_R,
            },
            {
                type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE,
                textureType: Constants.TEXTURETYPE_HALF_FLOAT,
                textureFormat: Constants.TEXTUREFORMAT_RGBA,
            },
        ];

        // ---- Scene-change pre-check pass ------------------------------------
        // This pass runs FIRST (before the geo render passes) inside the same
        // task._execute() loop.  When the combined scene+camera hash is unchanged,
        // it sets the geo renderer passes' disabled flags so they become no-ops in
        // the same frame.  The G-buffer textures retain their contents from the
        // previous frame — valid because the scene and camera did not move.
        const preCheckPass = this._frameGraph.addPass(`${this.name} Scene Check`);
        preCheckPass.setExecuteFunc(() => {
            const fh = this._computeSceneCameraHash(camera);
            const isStatic = fh === this._sceneAndCameraHash;
            this._sceneAndCameraHash = fh;
            for (const pass of this._geoPasses) {
                pass.disabled = isStatic;
            }
        });

        // ---- Record geometry renderer ---------------------------------------
        // Snapshot the pass count before and after to identify which passes
        // belong to the geo renderer so the pre-check can toggle them.
        const geoStart = this.passes.length;
        this._geoTask.record();
        this._geoPasses = this.passes.slice(geoStart);

        // ---- BVH + GI trace -------------------------------------------------
        this._bvhTask.record();

        this._giTraceTask.depthTexture = this._geoTask.geometryScreenDepthTexture;
        this._giTraceTask.normalTexture = this._geoTask.geometryWorldNormalTexture;
        this._giTraceTask.record();

        // Wire geometry + material managers.
        this._giTraceTask.setGeometryBuffers(this._bvhTask.geometryManager, this._bvhTask.materialManager);
        this._giTraceTask.setTextureManager(this._bvhTask.textureManager);

        // ---- Plugin update pass ---------------------------------------------
        // After the GI compute has written to giOutput, forward the texture handle
        // to all registered material plugins so the raster pass picks up irradiance.
        const updatePass = this._frameGraph.addPass(`${this.name} Plugin Update`);
        updatePass.setExecuteFunc((context) => {
            const giInternal = context.getTextureFromHandle(this._giTraceTask.outputTexture);
            if (!giInternal) {
                return;
            }

            for (const plugin of this._plugins) {
                if (!plugin.isEnabled) {
                    continue;
                }
                const needsDirty = !plugin.textureGIContrib;
                plugin.textureGIContrib = giInternal;
                plugin.outputTextureWidth = this._screenWidth;
                plugin.outputTextureHeight = this._screenHeight;
                if (needsDirty) {
                    plugin.markAllDefinesAsDirty();
                }
            }
        });
    }

    /** @inheritDoc */
    public override dispose(): void {
        if (this._materialAddedObserver) {
            this._scene.onNewMaterialAddedObservable.remove(this._materialAddedObserver);
            this._materialAddedObserver = null;
        }

        for (const plugin of this._plugins) {
            plugin.dispose();
        }
        this._plugins.length = 0;

        this._bvhTask?.dispose();
        this._giTraceTask?.dispose();
        super.dispose();
    }

    // ---- Private helpers ----------------------------------------------------

    private _registerPlugin(mat: Material): void {
        const existing = mat.pluginManager?.getPlugin(RtDiffuseGIPluginMaterial.Name);
        if (existing) {
            return;
        }

        try {
            const plugin = new RtDiffuseGIPluginMaterial(mat);
            plugin.isEnabled = !this._disabled;
            this._plugins.push(plugin);
        } catch {
            // Not all material types support plugins (e.g. ShaderMaterial); ignore.
        }
    }

    /**
     * Compute a fast O(mesh count) combined hash of mesh world-transform samples
     * and camera world-matrix samples.  Returns the same value if and only if no
     * mesh has moved and the camera has not moved since the last frame.
     * @param camera - the active camera whose world matrix is included in the hash
     * @returns a 32-bit hash that changes whenever any mesh or camera moves
     */
    private _computeSceneCameraHash(camera: Camera): number {
        const meshes = this._scene.meshes;
        let h = 0x811c9dc5 ^ meshes.length;

        for (const mesh of meshes) {
            if (!mesh.isEnabled() || !mesh.isVisible) {
                continue;
            }
            h = Math.imul(h ^ mesh.uniqueId, 0x01000193) >>> 0;
            const m = mesh.getWorldMatrix().m;
            h ^= (m[0] * 73856093) | 0;
            h ^= (m[5] * 19349663) | 0;
            h ^= (m[10] * 83492791) | 0;
            h ^= (m[12] * 73856093) | 0;
            h ^= (m[13] * 19349663) | 0;
            h ^= (m[14] * 83492791) | 0;
            h = Math.imul(h, 0x01000193) >>> 0;
        }

        // Fold in camera world matrix (position + orientation) to detect pan/rotate/zoom.
        const cm = camera.getWorldMatrix().m;
        h ^= (cm[12] * 73856093) | 0; // position X
        h ^= (cm[13] * 19349663) | 0; // position Y
        h ^= (cm[14] * 83492791) | 0; // position Z
        h ^= (cm[8] * 73856093) | 0; // forward X
        h ^= (cm[9] * 19349663) | 0; // forward Y
        h ^= (cm[10] * 83492791) | 0; // forward Z
        h = Math.imul(h, 0x01000193) >>> 0;

        return h;
    }
}
