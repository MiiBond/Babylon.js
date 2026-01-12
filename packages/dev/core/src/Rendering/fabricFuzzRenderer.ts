import type { Nullable } from "../types";
import type { Scene } from "../scene";
import { Mesh } from "../Meshes/mesh";
import type { AbstractMesh } from "../Meshes/abstractMesh";
import { OpenPBRMaterial } from "../Materials/PBR/openpbrMaterial";
import type { Material } from "../Materials/material";
import { Logger } from "../Misc/logger";
import { FabricFuzzPluginMaterial } from "../Materials/PBR/fabricFuzzPluginMaterial";
import { MeshSurfaceSampler } from "../Meshes/meshSurfaceSampler";
import type { ISurfaceSamplingData } from "../Meshes/meshSurfaceSampler";
import { RawTexture } from "../Materials/Textures/rawTexture";
import { Constants } from "../Engines/constants";
import { ToHalfFloat } from "../Misc/textureTools";
import { VertexBuffer } from "core/Meshes/buffer";
import type { Observer } from "../Misc/observable";
import type { TransformNode } from "../Meshes/transformNode";
import type { Node } from "../node";

interface IMaterialFiberInfo {
    material: OpenPBRMaterial;
    meshes: Map<number, IMeshData>;
    plugin: FabricFuzzPluginMaterial;
    observers: {
        onBind?: Nullable<Observer<AbstractMesh>>;
        onDisposed?: Nullable<Observer<Material>>;
    };
}

interface IMeshData {
    mesh: Mesh;
    offset: number;
    count: number;
    sampler: MeshSurfaceSampler;
    fiberMesh?: Mesh;
    observers: {
        onDisposed?: Nullable<Observer<Node>>;
        onWorldMatrixUpdated?: Nullable<Observer<TransformNode>>;
    };
}

/**
 * This class is responsible to render fabric fuzz effects.
 */
export class FabricFuzzRenderer {
    private _scene: Scene;

    private _materialInstanceMap: Map<OpenPBRMaterial, IMaterialFiberInfo> = new Map();

    private _currentOffset = 0;

    /**
     * Buffer that stores the position and seed data for the fibers.
     * TODO: Generate this data in a compute pass rather than on the CPU.
     */
    private _positionSeedBuffer: Nullable<Uint16Array> = null;

    /**
     * Buffer that stores the normal data for the fibers.
     */
    private _normalBuffer: Nullable<Uint16Array> = null;

    /**
     * Buffer that stores the UV data for the fibers.
     */
    private _uvBuffer: Nullable<Uint16Array> = null;

    /**
     * Buffer that stores the tangent data for the fibers.
     */
    private _tangentBuffer: Nullable<Uint16Array> = null;

    /**
     * Texture that stores the position and seed data for the fibers.
     */
    private _positionSeedTexture: Nullable<RawTexture> = null;

    /**
     * Texture that stores the normal data for the fibers.
     */
    private _normalTexture: Nullable<RawTexture> = null;

    /**
     * Texture that stores the UV data for the fibers.
     */
    private _uvTexture: Nullable<RawTexture> = null;

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
     * Adds a material to the fabric fuzz renderer
     * @param material Defines the OpenPBR material to add
     */
    public addMaterial(material: OpenPBRMaterial): void {
        if (this._materialInstanceMap.has(material) || !(material instanceof OpenPBRMaterial)) {
            Logger.Warn("FabricFuzzRenderer: Material already added to renderer.");
            return;
        }

        let plugin = material.pluginManager?.getPlugin<FabricFuzzPluginMaterial>(FabricFuzzPluginMaterial.Name);
        if (!plugin) {
            plugin = new FabricFuzzPluginMaterial(material);
            plugin.positionSeedTexture = this._positionSeedTexture;
            plugin.normalTexture = this._normalTexture;
            plugin.uvTexture = this._uvTexture;
            plugin.tangentTexture = this._tangentTexture;
            plugin.isEnabled = this.enabled;
        }

        const materialInfo: IMaterialFiberInfo = {
            material,
            meshes: new Map(),
            plugin,
            observers: {},
        };

        this._materialInstanceMap.set(material, materialInfo);
        this._bindMaterialObservables(materialInfo);
    }

    public removeMaterial(material: OpenPBRMaterial): void {
        const materialInfo = this._materialInstanceMap.get(material);
        if (!materialInfo) {
            Logger.Warn("FabricFuzzRenderer: Material not found in renderer. Call addMaterial() first.");
            return;
        }

        // Dispose all fiber meshes for this material
        materialInfo.meshes.forEach((meshData) => {
            if (meshData.fiberMesh) {
                meshData.fiberMesh.dispose();
            }
        });

        this._unbindMaterialObservables(materialInfo);
        this._materialInstanceMap.delete(material);
    }

    private _bindMaterialObservables(materialInfo: IMaterialFiberInfo): void {
        const material = materialInfo.material;

        // Listen for when the material is bound to meshes
        materialInfo.observers.onBind = material.onBindObservable.add((mesh) => {
            if (mesh instanceof Mesh && mesh.name !== "fabric_fuzz_fiber_instance") {
                this._addMeshToMaterial(materialInfo, mesh);
            }
        });

        // Listen for material disposal
        materialInfo.observers.onDisposed = material.onDisposeObservable.add(() => {
            this.removeMaterial(material);
        });
    }

    private _bindMeshObservables(materialInfo: IMaterialFiberInfo, mesh: Mesh): void {
        const meshData = materialInfo.meshes.get(mesh.uniqueId);
        if (!meshData) {
            return;
        }

        meshData.observers.onDisposed = mesh.onDisposeObservable.add(() => {
            this._removeMeshFromMaterial(materialInfo, mesh);
        });

        // Set up observer to keep bounding info in sync
        meshData.observers.onWorldMatrixUpdated = mesh.onAfterWorldMatrixUpdateObservable.add(() => {
            if (meshData.fiberMesh) {
                const meshBoundingInfo = mesh.getBoundingInfo();
                meshData.fiberMesh.buildBoundingInfo(meshBoundingInfo.minimum.clone(), meshBoundingInfo.maximum.clone(), mesh.getWorldMatrix());
            }
        });
    }

    private _unbindMaterialObservables(materialInfo: IMaterialFiberInfo): void {
        const material = materialInfo.material;

        // Clean up material observers
        if (materialInfo.observers.onBind) {
            material.onBindObservable.remove(materialInfo.observers.onBind);
        }

        if (materialInfo.observers.onDisposed) {
            material.onDisposeObservable.remove(materialInfo.observers.onDisposed);
        }

        // Clean up all mesh observers
        materialInfo.meshes.forEach((meshData) => {
            this._unbindMeshObservables(meshData, meshData.mesh);
        });

        // Clear the observers object
        materialInfo.observers = {};
    }

    private _unbindMeshObservables(meshData: IMeshData, mesh: Mesh): void {
        if (meshData.observers.onDisposed) {
            mesh.onDisposeObservable.remove(meshData.observers.onDisposed);
        }

        if (meshData.observers.onWorldMatrixUpdated && mesh.onAfterWorldMatrixUpdateObservable) {
            mesh.onAfterWorldMatrixUpdateObservable.remove(meshData.observers.onWorldMatrixUpdated);
        }

        // Clear the observers object
        meshData.observers = {};
    }

    /**
     * Update the density of fibers for the given material. This will regenerate fibers for all meshes using the material.
     * Currently, this requires regenerating fibers for all meshes since all fibers share the same texture buffers.
     * @param material The material who's fiber density has changed
     */
    public updateDensityForMaterial(material: OpenPBRMaterial): void {
        const materialInfo = this._materialInstanceMap.get(material);
        if (!materialInfo) {
            Logger.Warn("FabricFuzzRenderer: Material not found in renderer. Call addMaterial() first.");
            return;
        }

        this._currentOffset = 0;
        this._materialInstanceMap.forEach((materialInfo) => {
            materialInfo.meshes.forEach((meshData) => {
                this._updateFiberInstances(materialInfo, meshData.mesh);
            });
        });
    }

    public updateSegmentsForMaterial(material: OpenPBRMaterial): void {
        const materialInfo = this._materialInstanceMap.get(material);
        if (!materialInfo) {
            Logger.Warn("FabricFuzzRenderer: Material not found in renderer. Call addMaterial() first.");
            return;
        }
        materialInfo.meshes.forEach((meshData) => {
            this._updateFiberMesh(materialInfo, meshData.mesh, true);
        });
    }

    private _updateFiberInstances(materialInfo: IMaterialFiberInfo, mesh: Mesh): void {
        const meshData = materialInfo.meshes.get(mesh.uniqueId);
        if (!meshData) {
            Logger.Warn("FabricFuzzRenderer: Mesh not found in material. This should not happen.");
            return;
        }

        const surfaceSamplingData = this._generateFiberInstanceData(materialInfo, mesh);

        // Copy the data into the textures and record the offsets for this mesh
        if (!surfaceSamplingData) {
            Logger.Warn("FabricFuzzRenderer: No surface sampling data generated for mesh.");
            return;
        }
        meshData.count = surfaceSamplingData.positions.length;
        if (meshData.count > 0) {
            this._updateTextures(surfaceSamplingData, this._currentOffset);

            const plugin = materialInfo.plugin;
            plugin.fiberOffset = this._currentOffset;
            meshData.offset = this._currentOffset;

            Logger.Log(`Updating fibers for mesh ${mesh.name}: ${meshData.count} instances at offset ${meshData.offset}`);

            // The fiber mesh with instance info should be created and stored in the material plugin
            this._updateFiberMesh(materialInfo, mesh);

            this._currentOffset += surfaceSamplingData ? surfaceSamplingData.positions.length : 0;
        }
    }

    /**
     * Generates fibers for the given mesh and stores them in the appropriate buffers.
     * The fibers will be generated starting at the given offset and will require regenerating
     * fibers for other meshes added after this one.
     * @param materialInfo The material info containing the plugin
     * @param mesh The mesh to generate fibers for
     * @returns The surface sample data used to instance the fibers
     */
    private _generateFiberInstanceData(materialInfo: IMaterialFiberInfo, mesh: Mesh): Nullable<ISurfaceSamplingData> {
        const meshData = materialInfo.meshes.get(mesh.uniqueId);
        if (!meshData) {
            Logger.Warn("FabricFuzzRenderer: Mesh not found in material. This should not happen.");
            return null;
        }

        const plugin = materialInfo.plugin;
        plugin.surfaceMeshToWorldMatrix = mesh.getWorldMatrix();
        const meshSampler = meshData.sampler;

        const area = meshSampler.getTotalArea();
        let numFibers = Math.round(area * plugin.fiberDensity);
        if (numFibers + this._currentOffset > this.maxFibers) {
            Logger.Warn(`FabricFuzzRenderer: Requesting ${numFibers} fibers would exceed the maximum allowed. Capping to fit.`);
            numFibers = Math.max(this.maxFibers - this._currentOffset, 0);
            if (numFibers === 0) {
                Logger.Log("No more fibers can be added; maximum reached.");
            }
        }

        return meshSampler.generateSurfaceSamples(numFibers, 42);
    }

    private _createFiberMesh(segments: number = 10): Nullable<Mesh> {
        const fiberMesh = new Mesh("fabric_fuzz_fiber_instance", this._scene);

        // Create triangle strip geometry for fiber
        const positions: number[] = [];
        const uvs: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];

        const width = 0.25; // Half of the original diameter (0.5)

        // Generate vertices for triangle strip
        for (let i = 0; i <= segments; i++) {
            const y = i / segments; // Y coordinate from 0 to 1
            const u = i / segments; // UV coordinate along the strip

            // Left vertex
            positions.push(-width, y, 0);
            uvs.push(0, u);
            normals.push(0, 0, 1); // Normal pointing towards camera

            // Right vertex
            positions.push(width, y, 0);
            uvs.push(1, u);
            normals.push(0, 0, 1); // Normal pointing towards camera
        }

        // Generate triangle strip indices with clockwise winding order
        for (let i = 0; i < segments; i++) {
            const base = i * 2;

            // First triangle: bottom-left, top-left, bottom-right (clockwise)
            indices.push(base, base + 2, base + 1);
            // Second triangle: bottom-right, top-left, top-right (clockwise)
            indices.push(base + 1, base + 2, base + 3);
        }

        // Set the mesh data
        fiberMesh.setVerticesData(VertexBuffer.PositionKind, positions);
        fiberMesh.setVerticesData(VertexBuffer.UVKind, uvs);
        fiberMesh.setVerticesData(VertexBuffer.NormalKind, normals);
        fiberMesh.setIndices(indices);

        return fiberMesh;
    }

    /**
     * Updates or creates the fiber mesh for the given mesh and material.
     * @param materialInfo The material info
     * @param mesh The mesh to update the fiber instances for
     * @param forceRebuild If true, forces the fiber mesh to be rebuilt
     */
    private _updateFiberMesh(materialInfo: IMaterialFiberInfo, mesh: Mesh, forceRebuild: boolean = false): void {
        const meshData = materialInfo.meshes.get(mesh.uniqueId);
        if (!meshData) {
            Logger.Warn("FabricFuzzRenderer: Mesh not found in material. This should not happen.");
            return;
        }
        if (!meshData.fiberMesh || forceRebuild) {
            if (meshData.fiberMesh) {
                meshData.fiberMesh.dispose();
            }
            const fiberMesh = this._createFiberMesh(materialInfo.plugin.fiberSegments);
            if (!fiberMesh) {
                Logger.Warn("FabricFuzzRenderer: Failed to create fiber mesh.");
                return;
            }
            meshData.fiberMesh = fiberMesh;
        }

        // Update fiber mesh bounding info to match the original mesh
        // Ensure the mesh is fully ready before copying bounding info
        mesh.computeWorldMatrix(true);
        mesh.refreshBoundingInfo(true); // Force bounding info refresh
        const meshBoundingInfo = mesh.getBoundingInfo();
        meshData.fiberMesh.buildBoundingInfo(meshBoundingInfo.minimum.clone(), meshBoundingInfo.maximum.clone(), mesh.getWorldMatrix());

        meshData.fiberMesh.material = materialInfo.material;
        meshData.fiberMesh.isVisible = false; // Hide prototype mesh

        // Babylon.js needs a thin instance matrix buffer set to know how many instances to draw,
        // even if they aren't used.
        const instanceMatrices = new Float32Array(16 * meshData.count).fill(0);
        // Fill with identity matrices
        for (let i = 0; i < meshData.count; i++) {
            const offset = i * 16;
            instanceMatrices[offset + 0] = 1; // m00
            instanceMatrices[offset + 5] = 1; // m11
            instanceMatrices[offset + 10] = 1; // m22
            instanceMatrices[offset + 15] = 1; // m33
        }
        meshData.fiberMesh.thinInstanceSetBuffer("matrix", instanceMatrices, 16, false);
        meshData.fiberMesh.thinInstanceCount = meshData.count;
        meshData.fiberMesh.isVisible = true;
    }

    private _createTextures(): void {
        this._positionSeedBuffer = new Uint16Array(this._textureSize * this._textureSize * 4).fill(0);
        this._normalBuffer = new Uint16Array(this._textureSize * this._textureSize * 4).fill(0);
        this._uvBuffer = new Uint16Array(this._textureSize * this._textureSize * 4).fill(0);
        this._tangentBuffer = new Uint16Array(this._textureSize * this._textureSize * 4).fill(0);

        this._positionSeedTexture = RawTexture.CreateRGBATexture(
            this._positionSeedBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT
        );

        this._normalTexture = RawTexture.CreateRGBATexture(
            this._normalBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT
        );

        this._uvTexture = RawTexture.CreateRGBATexture(
            this._uvBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT
        );

        this._tangentTexture = RawTexture.CreateRGBATexture(
            this._tangentBuffer,
            this._textureSize,
            this._textureSize,
            this._scene,
            false,
            false,
            RawTexture.NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT
        );
    }

    private _updateTextures(surfaceSamplingData: ISurfaceSamplingData, offset: number): void {
        if (!this._positionSeedBuffer || !this._normalBuffer || !this._uvBuffer || !this._tangentBuffer) {
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
            const uv2 = surfaceSamplingData["uvs2"] ? surfaceSamplingData["uvs2"][i] : { x: 0, y: 0 };
            const tangent = surfaceSamplingData["tangents"] ? surfaceSamplingData["tangents"][i] : { x: 1, y: 0, z: 0, w: 1 };
            const index = offset + i;

            // Convert float values to half-float format
            this._positionSeedBuffer[index * 4 + 0] = ToHalfFloat(pos.x);
            this._positionSeedBuffer[index * 4 + 1] = ToHalfFloat(pos.y);
            this._positionSeedBuffer[index * 4 + 2] = ToHalfFloat(pos.z);
            this._positionSeedBuffer[index * 4 + 3] = ToHalfFloat(seed);

            this._normalBuffer[index * 4 + 0] = ToHalfFloat(norm.x);
            this._normalBuffer[index * 4 + 1] = ToHalfFloat(norm.y);
            this._normalBuffer[index * 4 + 2] = ToHalfFloat(norm.z);
            this._normalBuffer[index * 4 + 3] = ToHalfFloat(1);

            this._uvBuffer[index * 4 + 0] = ToHalfFloat(uv.x);
            this._uvBuffer[index * 4 + 1] = ToHalfFloat(uv.y);
            this._uvBuffer[index * 4 + 2] = ToHalfFloat(uv2.x);
            this._uvBuffer[index * 4 + 3] = ToHalfFloat(uv2.y);

            this._tangentBuffer[index * 4 + 0] = ToHalfFloat(tangent.x);
            this._tangentBuffer[index * 4 + 1] = ToHalfFloat(tangent.y);
            this._tangentBuffer[index * 4 + 2] = ToHalfFloat(tangent.z);
            this._tangentBuffer[index * 4 + 3] = ToHalfFloat(tangent.w);
        }
        this._positionSeedTexture!.update(this._positionSeedBuffer);
        this._normalTexture!.update(this._normalBuffer);
        this._uvTexture!.update(this._uvBuffer);
        this._tangentTexture!.update(this._tangentBuffer);
    }

    private _addMeshToMaterial(materialInfo: IMaterialFiberInfo, mesh: Mesh): void {
        if (materialInfo.meshes.has(mesh.uniqueId)) {
            return; // Already added
        }

        // Create a mesh sampler for the mesh and query the total surface area.
        const meshSampler = new MeshSurfaceSampler(mesh);

        const meshData: IMeshData = {
            offset: this._currentOffset,
            count: 0,
            sampler: meshSampler,
            observers: {},
            mesh: mesh,
        };

        materialInfo.meshes.set(mesh.uniqueId, meshData);

        meshSampler.preprocessMesh();
        Logger.Log(`Mesh total area: ${meshSampler.getTotalArea().toFixed(2)}`);
        this._bindMeshObservables(materialInfo, mesh);
        this._updateFiberInstances(materialInfo, mesh);
    }

    private _removeMeshFromMaterial(materialInfo: IMaterialFiberInfo, mesh: Mesh): void {
        const meshData = materialInfo.meshes.get(mesh.uniqueId);
        if (!meshData) {
            return;
        }

        // Dispose fiber mesh if it exists
        if (meshData.fiberMesh) {
            meshData.fiberMesh.dispose();
        }

        this._unbindMeshObservables(meshData, mesh);
        materialInfo.meshes.delete(mesh.uniqueId);
    }

    /**
     * Disposes the renderer and releases associated resources
     */
    public dispose(): void {
        // Clean up all materials
        this._materialInstanceMap.forEach((materialInfo, material) => {
            this.removeMaterial(material);
        });
        this._materialInstanceMap.clear();

        // Dispose textures
        if (this._positionSeedTexture) {
            this._positionSeedTexture.dispose();
            this._positionSeedTexture = null;
        }
        if (this._normalTexture) {
            this._normalTexture.dispose();
            this._normalTexture = null;
        }
        if (this._uvTexture) {
            this._uvTexture.dispose();
            this._uvTexture = null;
        }
        if (this._tangentTexture) {
            this._tangentTexture.dispose();
            this._tangentTexture = null;
        }

        // Clear buffers
        this._positionSeedBuffer = null;
        this._normalBuffer = null;
        this._uvBuffer = null;
        this._tangentBuffer = null;
    }
}
