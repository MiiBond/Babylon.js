import { type FrameGraph } from "core/FrameGraph/frameGraph";
import { type FrameGraphTextureHandle } from "core/FrameGraph/frameGraphTypes";
import { type Scene } from "core/scene";
import { type Camera } from "core/Cameras/camera";
import { type Material } from "core/Materials/material";
import { FrameGraphTask } from "core/FrameGraph/frameGraphTask";
import { Logger } from "core/Misc/logger";
import { FrameGraphRtBvhBuildTask } from "./frameGraphRtBvhBuildTask";
import { FrameGraphRtRayTracingTask, type IFrameGraphRtRayTracingOptions } from "./frameGraphRtRayTracingTask";

/**
 * Options for the composite ray tracer task.
 */
export interface IFrameGraphRayTracerOptions extends IFrameGraphRtRayTracingOptions {}

/**
 * Composite frame graph task that provides full-scene software ray tracing
 * via compute shaders (WebGPU only).
 *
 * Owns two child tasks:
 *  1. `FrameGraphRtBvhBuildTask` — rebuilds the BVH and uploads geometry.
 *  2. `FrameGraphRtRayTracingTask` — dispatches the megakernel and accumulates.
 *
 * Usage:
 * ```typescript
 * const rtTask = new FrameGraphRayTracerTask("RayTracer", frameGraph, scene, {
 *     width: 1920, height: 1080, maxBounces: 4,
 * });
 * // Optionally inject a custom closest-hit shader:
 * rtTask.addClosestHitShader(myMaterial, `
 *     fn userClosestHit(hit: HitRecord, ray: Ray, mat: RTMaterial,
 *                       depth: u32, seed: ptr<function, u32>) -> vec4f {
 *         return vec4f(hit.normal * 0.5 + 0.5, 1.0);
 *     }
 * `);
 * // Wire the output into your frame graph:
 * postProcess.inputTexture = rtTask.outputTexture;
 * ```
 */
export class FrameGraphRayTracerTask extends FrameGraphTask {
    private readonly _bvhTask: FrameGraphRtBvhBuildTask;
    private readonly _rtTask: FrameGraphRtRayTracingTask;
    private readonly _notSupported: boolean;

    /** Custom closest-hit WGSL source, or undefined for built-in shading */
    private _closestHitShaderSource?: string;
    /** Custom miss WGSL source, or undefined for built-in sky */
    private _missShaderSource?: string;
    /** Custom ray-gen WGSL source, or undefined for built-in camera ray */
    private _rayGenShaderSource?: string;

    // ---- Name propagation ---------------------------------------------------

    public override get name() {
        return this._name;
    }

    public override set name(value: string) {
        this._name = value;
        if (this._bvhTask) {
            this._bvhTask.name = `${value} BVH Build`;
        }
        if (this._rtTask) {
            this._rtTask.name = `${value} RT`;
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
        if (this._rtTask) {
            this._rtTask.disabled = value;
        }
        if (!value && this._rtTask) {
            this._rtTask.resetAccumulation = true;
        }
    }

    // ---- Camera wiring ------------------------------------------------------

    /**
     * The active camera used for ray generation.
     * Must be set before `record()` is called (or before the first rendered frame).
     * Changing the camera automatically resets progressive accumulation.
     */
    public get camera(): Camera | null {
        return this._rtTask?.camera ?? null;
    }

    public set camera(value: Camera | null) {
        if (this._rtTask) {
            this._rtTask.camera = value;
        }
    }

    // ---- Output texture -----------------------------------------------------

    /**
     * Final output texture handle produced by the ray tracer.
     * Connect this to a post-process or the frame graph back-buffer.
     */
    public get outputTexture(): FrameGraphTextureHandle {
        return this._rtTask.outputTexture;
    }

    // ---- Constructor --------------------------------------------------------

    constructor(name: string, frameGraph: FrameGraph, scene: Scene, options: IFrameGraphRayTracerOptions) {
        super(name, frameGraph);

        if (!frameGraph.engine.getCaps().supportComputeShaders) {
            this._notSupported = true;
            Logger.Warn(`${name}: WebGPU with compute shader support is required for ray tracing. Task is disabled.`);
            this._bvhTask = null!;
            this._rtTask = null!;
            return;
        }

        this._notSupported = false;

        this._bvhTask = new FrameGraphRtBvhBuildTask(`${name} BVH Build`, frameGraph, scene);
        this._rtTask = new FrameGraphRtRayTracingTask(`${name} RT`, frameGraph, scene, {
            width: options.width,
            height: options.height,
            maxBounces: options.maxBounces ?? 4,
        });
    }

    /**
     * {@inheritDoc}
     * @returns The class name string
     */
    public override getClassName(): string {
        return "FrameGraphRayTracerTask";
    }

    /**
     * {@inheritDoc}
     * @returns True when all child tasks are ready to render
     */
    public override isReady(): boolean {
        if (this._notSupported) {
            return true;
        }
        return this._bvhTask.isReady() && this._rtTask.isReady();
    }

    // ---- User shader injection ----------------------------------------------

    /**
     * Injects a custom WGSL function body for the closest-hit stage.
     * The function must have this exact signature:
     * ```wgsl
     * fn userClosestHit(hit: HitRecord, ray: Ray, mat: RTMaterial,
     *                   depth: u32, seed: ptr<function, u32>) -> vec4f
     * ```
     * Return `vec4f(-1.0)` to fall through to built-in shading.
     * @param _material Unused for now (all materials share one hit function).
     *   In a future version this will dispatch per-material via a switch table.
     * @param wgslSource The WGSL function source (just the function body).
     */

    public addClosestHitShader(_material: Material | null, wgslSource: string): void {
        this._closestHitShaderSource = wgslSource;
        this._rebuildProcessFinalCode();
    }

    /**
     * Injects a custom WGSL function body for the miss stage (sky/environment).
     * Signature:
     * ```wgsl
     * fn userMiss(ray: Ray, depth: u32, seed: ptr<function, u32>) -> vec4f
     * ```
     * Return `vec4f(-1.0)` to fall through to built-in sky shading.
     * @param wgslSource Complete WGSL `fn userMiss(...)` function declaration
     */
    public setMissShader(wgslSource: string): void {
        this._missShaderSource = wgslSource;
        this._rebuildProcessFinalCode();
    }

    /**
     * Injects a custom WGSL function body for ray generation.
     * Signature:
     * ```wgsl
     * fn userRayGen(ray: ptr<function, Ray>, seed: ptr<function, u32>)
     * ```
     * @param wgslSource Complete WGSL `fn userRayGen(...)` function declaration
     */
    public setRayGenShader(wgslSource: string): void {
        this._rayGenShaderSource = wgslSource;
        this._rebuildProcessFinalCode();
    }

    /** Removes any custom closest-hit shader; built-in shading is restored. */
    public removeClosestHitShader(): void {
        this._closestHitShaderSource = undefined;
        this._rebuildProcessFinalCode();
    }

    // ---- Frame graph record -------------------------------------------------

    public override record(): void {
        if (this._notSupported) {
            return;
        }

        this._bvhTask.record();
        this._rtTask.record();

        // Wire geometry + material buffers after record() so buffer references are fresh
        this._rtTask.setGeometryBuffers(this._bvhTask.geometryManager, this._bvhTask.materialManager);
        // Wire the texture manager so the RT task can bind the material texture array
        this._rtTask.setTextureManager(this._bvhTask.textureManager);
    }

    // ---- Dispose ------------------------------------------------------------

    public override dispose(): void {
        this._bvhTask?.dispose();
        this._rtTask?.dispose();
        super.dispose();
    }

    // ---- Private helpers ----------------------------------------------------

    private _rebuildProcessFinalCode(): void {
        if (!this._rtTask) {
            return;
        }

        const hasOverrides = this._closestHitShaderSource !== undefined || this._missShaderSource !== undefined || this._rayGenShaderSource !== undefined;

        if (!hasOverrides) {
            this._rtTask.processFinalCode = undefined;
        } else {
            this._rtTask.processFinalCode = (code: string) => {
                let result = code;
                if (this._closestHitShaderSource !== undefined) {
                    // Replace the default userClosestHit function with the user's version
                    result = this._replaceFunction(result, "userClosestHit", this._closestHitShaderSource);
                }
                if (this._missShaderSource !== undefined) {
                    result = this._replaceFunction(result, "userMiss", this._missShaderSource);
                }
                if (this._rayGenShaderSource !== undefined) {
                    result = this._replaceFunction(result, "userRayGen", this._rayGenShaderSource);
                }
                return result;
            };
        }

        // Rebuild the ComputeShader with the updated (or cleared) processFinalCode
        // baked directly into the WGSL source.  This must happen after processFinalCode
        // is set above so _createShader() picks up the new value.
        this._rtTask.rebuildShader();
    }

    /**
     * Replaces the body of a WGSL function `fnName` with `newSource`.
     * Assumes `newSource` is a complete `fn fnName(...) { ... }` declaration.
     * @param code Full WGSL shader source string
     * @param fnName Name of the function to replace (without `fn ` prefix)
     * @param newSource Replacement WGSL function (complete declaration)
     * @returns Updated shader source with the function replaced
     */
    private _replaceFunction(code: string, fnName: string, newSource: string): string {
        // Match "fn fnName" up to and including its matching closing brace
        const startMarker = `fn ${fnName}`;
        const start = code.indexOf(startMarker);
        if (start === -1) {
            return code + "\n" + newSource;
        }

        // Find the opening brace
        const braceStart = code.indexOf("{", start);
        if (braceStart === -1) {
            return code + "\n" + newSource;
        }

        // Scan for the matching closing brace
        let depth = 0;
        let end = braceStart;
        for (let i = braceStart; i < code.length; i++) {
            if (code[i] === "{") {
                depth++;
            } else if (code[i] === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }

        return code.slice(0, start) + newSource + code.slice(end + 1);
    }
}
