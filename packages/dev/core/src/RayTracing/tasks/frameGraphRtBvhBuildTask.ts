import { type FrameGraph } from "core/FrameGraph/frameGraph";
import { type Scene } from "core/scene";
import { type WebGPUEngine } from "core/Engines/webgpuEngine";
import { FrameGraphTask } from "core/FrameGraph/frameGraphTask";
import { Logger } from "core/Misc/logger";
import { RtGeometryManager } from "../geometry/rtGeometryManager";
import { RtMaterialManager } from "../materials/rtMaterialManager";
import { RtTextureManager } from "../materials/rtTextureManager";
import { SnapshotScene } from "../geometry/rtSceneSnapshot";

/**
 * Frame graph task that rebuilds BVH data and uploads geometry + material
 * buffers to the GPU.  This is a lightweight "prep" pass that runs before
 * the megakernel dispatch.
 *
 * The task is a no-op when the engine does not support compute shaders.
 * @internal
 */
export class FrameGraphRtBvhBuildTask extends FrameGraphTask {
    private readonly _scene: Scene;
    private readonly _geometryManager: RtGeometryManager;
    private readonly _materialManager: RtMaterialManager;
    private readonly _textureManager: RtTextureManager;
    private readonly _notSupported: boolean;

    /** Access the geometry manager to bind its buffers to the megakernel. */
    public get geometryManager(): RtGeometryManager {
        return this._geometryManager;
    }

    /** Access the material manager to bind its buffer to the megakernel. */
    public get materialManager(): RtMaterialManager {
        return this._materialManager;
    }

    /** Access the texture manager to bind its texture array to the megakernel. */
    public get textureManager(): RtTextureManager {
        return this._textureManager;
    }

    /**
     * Creates a new FrameGraphRtBvhBuildTask.
     * @param name - Task name
     * @param frameGraph - The owning frame graph
     * @param scene - The scene whose geometry and materials will be uploaded to the GPU
     */
    constructor(name: string, frameGraph: FrameGraph, scene: Scene) {
        super(name, frameGraph);

        this._scene = scene;

        if (!frameGraph.engine.getCaps().supportComputeShaders) {
            this._notSupported = true;
            Logger.Error(`${name}: compute shaders are not supported (WebGPU required).`);
            this._geometryManager = null!;
            this._materialManager = null!;
            this._textureManager = null!;
            return;
        }

        this._notSupported = false;
        const gpuEngine = frameGraph.engine as WebGPUEngine;
        this._geometryManager = new RtGeometryManager(gpuEngine);
        this._materialManager = new RtMaterialManager(gpuEngine);
        this._textureManager = new RtTextureManager(scene);
    }

    /**
     * {@inheritDoc}
     * @returns The class name string
     */
    public override getClassName(): string {
        return "FrameGraphRtBvhBuildTask";
    }

    /** {@inheritDoc} */
    public override record(): void {
        const pass = this._frameGraph.addPass(this.name);

        if (this._notSupported) {
            pass.setExecuteFunc(() => {});
            return;
        }

        pass.setExecuteFunc(() => {
            // Start async texture upload; no-op if already running or unchanged.
            // The texture manager's texIndexMap is populated after the first upload completes.
            this._textureManager.requestUpload(this._scene);

            // Rebuild material buffer — passes the current texIndexMap so texture indices
            // are baked into the RTMaterial structs.  On the very first frame the map is
            // empty (upload not finished yet), so all texture slots get NO_TEX; subsequent
            // frames will use the populated map once the async upload completes.
            this._materialManager.upload(this._scene, this._textureManager.texIndexMap);

            // Snapshot scene geometry and upload BVH + triangles
            const snapshot = SnapshotScene(this._scene, this._materialManager.materialIndexMap);
            this._geometryManager.upload(snapshot);
        });
    }

    /** {@inheritDoc} */
    public override dispose(): void {
        this._geometryManager?.dispose();
        this._materialManager?.dispose();
        this._textureManager?.dispose();
        super.dispose();
    }
}
