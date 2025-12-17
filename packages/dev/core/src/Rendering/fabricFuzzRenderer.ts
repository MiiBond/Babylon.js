import type { Nullable } from "../types";
import type { Scene } from "../scene";
import type { Mesh } from "../Meshes/mesh";
import { OpenPBRMaterial } from "../Materials/PBR/openpbrMaterial";
import type { Material } from "../Materials/material";
import { Logger } from "../Misc/logger";
import { FabricFuzzPluginMaterial } from "../Materials/PBR/fabricFuzzPluginMaterial";
import { MeshSurfaceSampler } from "../Meshes/meshSurfaceSampler";
import type { ISurfaceSamplingData } from "../Meshes/meshSurfaceSampler";
import { RawTexture } from "../Materials/Textures/rawTexture";
import { Constants } from "../Engines/constants";
import { MeshBuilder } from "core/Meshes/meshBuilder";
import { VertexBuffer } from "core/Meshes/buffer";

interface IMeshFiberInfo {
    offset: number;
    count: number;
    sampler: MeshSurfaceSampler;
    fiberMesh?: Mesh;
}

/**
 * This class is responsible to render fabric fuzz effects.
 */
export class FabricFuzzRenderer {
    private _scene: Scene;

    private _meshInstanceMap: Map<Mesh, IMeshFiberInfo> = new Map();

    private _currentOffset = 0;

    /**
     * Buffer that stores the position and seed data for the fibers.
     * TODO: Generate this data in a compute pass rather than on the CPU.
     */
    private _positionSeedBuffer: Nullable<Float32Array> = null;

    /**
     * Buffer that stores the normal and UV data for the fibers.
     */
    private _normalUVBuffer: Nullable<Float32Array> = null;

    /**
     * Buffer that stores the tangent data for the fibers.
     */
    private _tangentBuffer: Nullable<Float32Array> = null;

    /**
     * Texture that stores the position and seed data for the fibers.
     */
    private _positionSeedTexture: Nullable<RawTexture> = null;

    /**
     * Texture that stores the normal and UV data for the fibers.
     */
    private _normalUVTexture: Nullable<RawTexture> = null;

    /**
     * Texture that stores the tangent data for the fibers.
     */
    private _tangentTexture: Nullable<RawTexture> = null;

    /**
     * The size of the textures used to store fiber data. This determines the maximum number of fibers
     * that can be rendered (_textureSize * _textureSize).
     */
    private _textureSize: number;

    /**
     * Returns the maximum number of fibers that can be rendered
     */
    public get maxFibers(): number {
        return this._textureSize * this._textureSize;
    }

    /**
     * Gets or sets a boolean indicating if the renderer is enabled
     */
    public enabled = true;

    /**
     * Instantiates a new fabric fuzz renderer.
     * @param scene Defines the scene the renderer belongs to
     * @param maxFibers The maximum number of fibers that can be rendered at once.
     */
    constructor(scene: Scene, maxFibers: number) {
        this._scene = scene;

        this._textureSize = Math.floor(Math.sqrt(maxFibers));
        this._createTextures();
    }

    /**
     * Gets the scene the renderer belongs to
     * @returns the scene
     */
    public getScene(): Scene {
        return this._scene;
    }

    /**
     * Checks if the renderer is ready
     * @returns true if the renderer is ready
     */
    public isReady(): boolean {
        // TODO: Implement readiness check
        return true;
    }

    public get isSupported(): boolean {
        // TODO: Implement support check
        return true;
    }

    /**
     * Adds a mesh to the fabric fuzz renderer
     * @param mesh Defines the mesh to add
     */
    public addMesh(mesh: Mesh): void {
        // If mesh has an OpenPBRMaterial, add a fabric fuzz material plugin to it.
        if (!mesh.material) {
            return;
        }
        if (!(mesh.material instanceof OpenPBRMaterial)) {
            Logger.Warn("FabricFuzzRenderer: Mesh does not have an OpenPBRMaterial. Fabric fuzz effect will not be applied.");
            return;
        }

        let plugin = mesh.material.pluginManager?.getPlugin<FabricFuzzPluginMaterial>(FabricFuzzPluginMaterial.Name);
        if (!plugin) {
            plugin = new FabricFuzzPluginMaterial(mesh.material);
            plugin.positionSeedTexture = this._positionSeedTexture!.getInternalTexture();
            plugin.normalUVTexture = this._normalUVTexture!.getInternalTexture();
            plugin.tangentTexture = this._tangentTexture!.getInternalTexture();
            plugin.isEnabled = this.enabled;
        }

        // Create a mesh sampler for the mesh and query the total surface area.
        // - start with the world positions and then try using local positions?
        // - we should also load the tangent data, if available, to better align fibers
        const meshSampler = new MeshSurfaceSampler(mesh);
        meshSampler.preprocessMesh();

        // Store a map of mesh-material pairs and their associated fiber mesh and instance offset/count
        this._meshInstanceMap.set(mesh, { offset: this._currentOffset, count: 0, sampler: meshSampler });

        this._updateFiberInstances(mesh);
    }

    public updateDensityForMaterial(material: Material): void {
        this._meshInstanceMap.forEach((meshInfo, mesh) => {
            if (mesh.material === material) {
                this._updateFiberInstances(mesh);
            }
        });
    }

    private _updateFiberInstances(mesh: Mesh): void {
        const meshInfo = this._meshInstanceMap.get(mesh);
        if (!meshInfo) {
            Logger.Warn("FabricFuzzRenderer: Mesh not found in renderer. Call addMesh() first.");
            return;
        }

        const surfaceSamplingData = this._generateFiberInstanceData(mesh);
        // TODO: mesh.onMaterialChangedObservable to handle material changes

        // Copy the data into the textures and record the offsets for this mesh
        if (!surfaceSamplingData) {
            Logger.Warn("FabricFuzzRenderer: No surface sampling data generated for mesh.");
            return;
        }
        meshInfo.count = surfaceSamplingData.positions.length;

        this._updateTextures(surfaceSamplingData, meshInfo.offset);

        this._currentOffset += surfaceSamplingData ? surfaceSamplingData.positions.length : 0;

        // The fiber mesh with instance info should be created and stored in the material plugin
        this._updateFiberMesh(mesh);
    }

    /**
     * Generates fibers for the given mesh and stores them in the appropriate buffers.
     * The fibers will be generated starting at the given offset and will require regenerating
     * fibers for other meshes added after this one.
     * @param mesh The mesh to generate fibers for
     * @returns The surface sample data used to instance the fibers
     */
    private _generateFiberInstanceData(mesh: Mesh): Nullable<ISurfaceSamplingData> {
        const meshInfo = this._meshInstanceMap.get(mesh);
        if (!meshInfo) {
            Logger.Warn("FabricFuzzRenderer: Mesh not found in renderer. Call addMesh() first.");
            return null;
        }
        const surfaceMaterial = mesh.material as OpenPBRMaterial;
        if (!surfaceMaterial || !(mesh.material instanceof OpenPBRMaterial)) {
            Logger.Warn("FabricFuzzRenderer: Mesh does not have a compatible material to apply fabric fuzz to.");
            return null;
        }
        const plugin = surfaceMaterial.pluginManager!.getPlugin<FabricFuzzPluginMaterial>(FabricFuzzPluginMaterial.Name)!;
        if (!plugin) {
            Logger.Warn("FabricFuzzRenderer: Material does not have FabricFuzzPluginMaterial.");
            return null;
        }
        plugin.surfaceMeshToWorldMatrix = mesh.getWorldMatrix();
        const meshSampler = meshInfo.sampler;

        // TODO: total area should be in world space so that the resulting density is correct
        const area = meshSampler.getTotalArea();
        let numFibers = Math.round(area * plugin.fiberDensity);
        if (numFibers > this.maxFibers) {
            numFibers = this.maxFibers;
            Logger.Log("Number of fibers exceeded maximum");
        }

        // TODO: the fiber generation logic should be in local mesh space so that
        // future transforms do not require regenerating fibers. The exception, of course,
        // is if the mesh is scaled and the density requires the number of fibers to change.
        return meshSampler.generateSurfaceSamples(numFibers, 42);
    }

    private _createFiberMesh(segments: number = 10): Nullable<Mesh> {
        const fiberMesh = MeshBuilder.CreateCylinder(
            "fabric_fuzz_fiber_instance",
            {
                height: 1.0,
                diameter: 0.5,
                tessellation: 2,
                subdivisions: segments,
                hasRings: true,
            },
            this._scene
        );

        // Shift cylinder pivot to bottom center ---
        const vertPositions = fiberMesh.getVerticesData(VertexBuffer.PositionKind);
        if (!vertPositions) {
            Logger.Warn("Failed to get vertex positions for fiber mesh.");
            return null;
        }
        const offset = 0.5;
        // Adjust the Y coordinate of every vertex to shift the mesh upwards
        for (let i = 1; i < vertPositions.length; i += 3) {
            vertPositions[i] += offset;
        }
        fiberMesh.setVerticesData(VertexBuffer.PositionKind, vertPositions);
        return fiberMesh;
    }

    /**
     * Update the fiber mesh to render the given number of fiber instances.
     * @param mesh The mesh to update the fiber instances for
     */
    private _updateFiberMesh(mesh: Mesh): void {
        const meshInfo = this._meshInstanceMap.get(mesh);
        if (!meshInfo) {
            Logger.Warn("FabricFuzzRenderer: Mesh not found in renderer. Call addMesh() first.");
            return;
        }
        if (!meshInfo.fiberMesh) {
            const fiberMesh = this._createFiberMesh();
            if (!fiberMesh) {
                Logger.Warn("FabricFuzzRenderer: Failed to create fiber mesh.");
                return;
            }
            meshInfo.fiberMesh = fiberMesh;
        }

        meshInfo.fiberMesh.material = mesh.material;
        meshInfo.fiberMesh.isVisible = false; // Hide prototype mesh

        // Babylon.js needs a thin instance matrix buffer set to know how many instances to draw,
        // even if they aren't used.
        const instanceMatrices = new Float32Array(16 * meshInfo.count).fill(0);
        // Fill with identity matrices
        for (let i = 0; i < meshInfo.count; i++) {
            const offset = i * 16;
            instanceMatrices[offset + 0] = 1; // m00
            instanceMatrices[offset + 5] = 1; // m11
            instanceMatrices[offset + 10] = 1; // m22
            instanceMatrices[offset + 15] = 1; // m33
        }
        meshInfo.fiberMesh.thinInstanceSetBuffer("matrix", instanceMatrices, 16, false);
        meshInfo.fiberMesh.thinInstanceCount = meshInfo.count;
        meshInfo.fiberMesh.isVisible = true;
    }

    private _createTextures(): void {
        this._positionSeedBuffer = new Float32Array(this._textureSize * this._textureSize * 4).fill(0);
        this._normalUVBuffer = new Float32Array(this._textureSize * this._textureSize * 4).fill(0);
        this._tangentBuffer = new Float32Array(this._textureSize * this._textureSize * 4).fill(0);

        this._positionSeedTexture = RawTexture.CreateRGBATexture(
            this._positionSeedBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );

        this._normalUVTexture = RawTexture.CreateRGBATexture(
            this._normalUVBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );

        this._tangentTexture = RawTexture.CreateRGBATexture(
            this._tangentBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
    }

    private _updateTextures(surfaceSamplingData: ISurfaceSamplingData, offset: number): void {
        if (!this._positionSeedBuffer || !this._normalUVBuffer || !this._tangentBuffer) {
            return;
        }

        const numSamples = surfaceSamplingData.positions.length;
        if (offset + numSamples > this.maxFibers) {
            Logger.Warn("FabricFuzzRenderer: Exceeded maximum number of fibers.");
            return;
        }

        for (let i = 0; i < numSamples && offset + i < this.maxFibers; i++) {
            const pos = surfaceSamplingData.positions[i];
            const norm = surfaceSamplingData.normals[i];
            const seed = surfaceSamplingData.seeds[i];
            const uv = surfaceSamplingData["uvs"] ? surfaceSamplingData["uvs"][i] : { x: 0, y: 0 };
            const tangent = surfaceSamplingData["tangents"] ? surfaceSamplingData["tangents"][i] : { x: 1, y: 0, z: 0, w: 1 };
            const index = offset + i;
            this._positionSeedBuffer[index * 4 + 0] = pos.x;
            this._positionSeedBuffer[index * 4 + 1] = pos.y;
            this._positionSeedBuffer[index * 4 + 2] = pos.z;
            this._positionSeedBuffer[index * 4 + 3] = seed;

            // *** I can't do this. It only makes sense to pack normal.xy if we know that z is positive (or negative).
            this._normalUVBuffer[index * 4 + 0] = norm.x;
            this._normalUVBuffer[index * 4 + 1] = norm.y;
            this._normalUVBuffer[index * 4 + 2] = uv.x;
            this._normalUVBuffer[index * 4 + 3] = uv.y;

            this._tangentBuffer[index * 4 + 0] = tangent.x;
            this._tangentBuffer[index * 4 + 1] = tangent.y;
            this._tangentBuffer[index * 4 + 2] = tangent.z;
            this._tangentBuffer[index * 4 + 3] = tangent.w;
        }
        this._positionSeedTexture!.update(this._positionSeedBuffer);
        this._normalUVTexture!.update(this._normalUVBuffer);
        this._tangentTexture!.update(this._tangentBuffer);
    }

    /**
     * Disposes the renderer and releases associated resources
     */
    public dispose(): void {
        // TODO: Implement disposal logic
    }
}
