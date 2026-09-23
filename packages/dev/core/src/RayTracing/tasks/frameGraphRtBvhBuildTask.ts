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

    /** Fast scene hash from the last frame — mesh IDs + transforms + emissive properties. */
    private _fastSceneHash = 0;

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
            // ---- Fast scene hash ------------------------------------------------
            // Hash mesh count + IDs + world transforms + emissive material values.
            // This is O(meshCount), not O(triangleCount), and avoids reading vertex
            // data.  If nothing changed since the last frame we can skip the entire
            // snapshot + upload pipeline.
            const meshes = this._scene.meshes;
            let fh = 0x811c9dc5 ^ meshes.length;
            for (const mesh of meshes) {
                if (!mesh.isEnabled() || !mesh.isVisible) {
                    continue;
                }
                fh = Math.imul(fh ^ mesh.uniqueId, 0x01000193) >>> 0;
                const m = mesh.getWorldMatrix().m;
                // Sample 6 matrix elements — catches translation + rotation changes.
                fh ^= (m[0] * 73856093) | 0;
                fh ^= (m[5] * 19349663) | 0;
                fh ^= (m[10] * 83492791) | 0;
                fh ^= (m[12] * 73856093) | 0;
                fh ^= (m[13] * 19349663) | 0;
                fh ^= (m[14] * 83492791) | 0;
                fh = Math.imul(fh, 0x01000193) >>> 0;

                // Fold in emissive state so a material change forces a rebuild.
                const mat = mesh.material as unknown as {
                    emissionLuminance?: number;
                    emissionColor?: { r: number; g: number; b: number };
                } | null;
                if (mat?.emissionLuminance) {
                    fh ^= (mat.emissionLuminance * 1000) | 0;
                }
            }

            const sceneUnchanged = fh === this._fastSceneHash && this._geometryManager.instanceCount > 0;
            this._fastSceneHash = fh;

            // Always tick the async texture upload (no-op if already done).
            this._textureManager.requestUpload(this._scene);

            if (sceneUnchanged) {
                // Scene is identical to last frame — GPU buffers are still valid.
                // Still update materials in case texture upload just completed.
                this._materialManager.upload(this._scene, this._textureManager.texIndexMap);
                return;
            }

            // ---- Full rebuild ---------------------------------------------------
            this._materialManager.upload(this._scene, this._textureManager.texIndexMap);

            const snapshot = SnapshotScene(this._scene, this._materialManager.materialIndexMap);
            this._geometryManager.upload(snapshot);

            const meshEmissiveLe: Array<[number, number, number] | null> = snapshot.meshGeometries.map((geom) => {
                const mat = geom.mesh.material;
                if (!mat) {
                    return null;
                }
                const cls = mat.getClassName?.() ?? "";
                const m = mat as unknown as {
                    emissionLuminance?: number;
                    emissionColor?: { r: number; g: number; b: number };
                    emissiveColor?: { r: number; g: number; b: number };
                    emissiveIntensity?: number;
                };

                let lr: number, lg: number, lb: number;

                if (cls === "OpenPBRMaterial") {
                    const lum = m.emissionLuminance ?? 0;
                    if (lum <= 0) {
                        return null;
                    }
                    const ec = m.emissionColor ?? { r: 0, g: 0, b: 0 };
                    lr = ec.r * lum;
                    lg = ec.g * lum;
                    lb = ec.b * lum;
                } else if (cls === "PBRMaterial" || cls === "PBRMetallicRoughnessMaterial") {
                    const ec = m.emissiveColor ?? { r: 0, g: 0, b: 0 };
                    const intensity = m.emissiveIntensity ?? 1;
                    lr = ec.r * intensity;
                    lg = ec.g * intensity;
                    lb = ec.b * intensity;
                } else if (cls === "StandardMaterial") {
                    const ec = m.emissiveColor ?? { r: 0, g: 0, b: 0 };
                    lr = ec.r;
                    lg = ec.g;
                    lb = ec.b;
                } else {
                    return null;
                }

                if (lr <= 0 && lg <= 0 && lb <= 0) {
                    return null;
                }
                return [lr, lg, lb];
            });
            this._geometryManager.uploadEmissive(snapshot, meshEmissiveLe);
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
