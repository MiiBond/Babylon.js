import { MaterialDefines } from "core/Materials/materialDefines";
import { MaterialPluginBase } from "core/Materials/materialPluginBase";
import type { InternalTexture } from "core/Materials/Textures/internalTexture";
import { Constants } from "core/Engines/constants";
import { Color3 } from "core/Maths/math.color";
import { OpenPBRMaterial } from "core/Materials/PBR/openpbrMaterial";
import type { UniformBuffer } from "core/Materials/uniformBuffer";
import { expandToProperty, serialize } from "core/Misc/decorators";
import { RegisterClass } from "core/Misc/typeStore";
import type { Scene } from "core/scene";
import type { AbstractEngine } from "core/Engines/abstractEngine";
import type { SubMesh } from "core/Meshes/subMesh";
import type { Nullable } from "core/types";
import type { ShaderLanguage } from "core/Materials/shaderLanguage";
import type { Material } from "core/Materials/material";
import type { AbstractMesh } from "core/Meshes/abstractMesh";
import { Matrix } from "core/Maths/math.vector";
import type { BaseTexture } from "core/Materials/Textures/baseTexture";

/**
 * @internal
 */
class MaterialFabricFuzzRenderDefines extends MaterialDefines {
    public FABRIC_FUZZ = false;
    public FABRIC_FUZZ_DENSITY_TEXTURE = false;
    public FABRIC_FUZZ_LENGTH_TEXTURE = false;
    public FABRIC_FUZZ_RADIUS_TEXTURE = false;
    public FABRIC_FUZZ_TILT_TEXTURE = false;
    public FABRIC_FUZZ_CHAOS_TEXTURE = false;
    public FABRIC_FUZZ_CURL_TEXTURE = false;
    public FABRIC_FUZZ_TAPER_TEXTURE = false;
    public FABRIC_FUZZ_TIP_COLOR_TEXTURE = false;
}

/**
 * Plugin used to render the contribution from IBL shadows.
 */
export class FabricFuzzPluginMaterial extends MaterialPluginBase {
    /**
     * Defines the name of the plugin.
     */
    public static readonly Name = "FabricFuzzPluginMaterial";

    /**
     * The texture containing the position and random seed for each fiber.
     */
    public positionSeedTexture: Nullable<InternalTexture> = null;

    /**
     * The texture containing the normal for each fiber.
     */
    public normalTexture: Nullable<InternalTexture> = null;

    /**
     * The texture containing the UV coordinates for each fiber.
     */
    public uvTexture: Nullable<InternalTexture> = null;

    /**
     * The texture containing the tangent at the surface for each fiber.
     */
    public tangentTexture: Nullable<InternalTexture> = null;

    /**
     * Texture used to modulate fiber density across the surface.
     */
    private _fiberDensityTexture: Nullable<BaseTexture> = null;
    @serialize("fiberDensityTexture")
    public get fiberDensityTexture(): Nullable<BaseTexture> {
        return this._fiberDensityTexture;
    }
    public set fiberDensityTexture(value: Nullable<BaseTexture>) {
        if (this._fiberDensityTexture === value) {
            return;
        }
        this._fiberDensityTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate fiber length across the surface.
     */
    private _fiberLengthTexture: Nullable<BaseTexture> = null;
    @serialize("fiberLengthTexture")
    public get fiberLengthTexture(): Nullable<BaseTexture> {
        return this._fiberLengthTexture;
    }
    public set fiberLengthTexture(value: Nullable<BaseTexture>) {
        if (this._fiberLengthTexture === value) {
            return;
        }
        this._fiberLengthTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate fiber radius across the surface.
     */
    private _fiberRadiusTexture: Nullable<BaseTexture> = null;
    @serialize("fiberRadiusTexture")
    public get fiberRadiusTexture(): Nullable<BaseTexture> {
        return this._fiberRadiusTexture;
    }
    public set fiberRadiusTexture(value: Nullable<BaseTexture>) {
        if (this._fiberRadiusTexture === value) {
            return;
        }
        this._fiberRadiusTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate fiber tilt across the surface.
     */
    private _fiberTiltTexture: Nullable<BaseTexture> = null;
    @serialize("fiberTiltTexture")
    public get fiberTiltTexture(): Nullable<BaseTexture> {
        return this._fiberTiltTexture;
    }
    public set fiberTiltTexture(value: Nullable<BaseTexture>) {
        if (this._fiberTiltTexture === value) {
            return;
        }
        this._fiberTiltTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate fiber chaos across the surface.
     */
    private _fiberChaosTexture: Nullable<BaseTexture> = null;
    @serialize("fiberChaosTexture")
    public get fiberChaosTexture(): Nullable<BaseTexture> {
        return this._fiberChaosTexture;
    }
    public set fiberChaosTexture(value: Nullable<BaseTexture>) {
        if (this._fiberChaosTexture === value) {
            return;
        }
        this._fiberChaosTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate fiber curl across the surface.
     */
    private _fiberCurlTexture: Nullable<BaseTexture> = null;
    @serialize("fiberCurlTexture")
    public get fiberCurlTexture(): Nullable<BaseTexture> {
        return this._fiberCurlTexture;
    }
    public set fiberCurlTexture(value: Nullable<BaseTexture>) {
        if (this._fiberCurlTexture === value) {
            return;
        }
        this._fiberCurlTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate fiber taper across the surface.
     */
    private _fiberTaperTexture: Nullable<BaseTexture> = null;
    @serialize("fiberTaperTexture")
    public get fiberTaperTexture(): Nullable<BaseTexture> {
        return this._fiberTaperTexture;
    }
    public set fiberTaperTexture(value: Nullable<BaseTexture>) {
        if (this._fiberTaperTexture === value) {
            return;
        }
        this._fiberTaperTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Texture used to modulate tip color blend across the surface.
     */
    private _fiberTipColorTexture: Nullable<BaseTexture> = null;
    @serialize("fiberTipColorTexture")
    public get fiberTipColorTexture(): Nullable<BaseTexture> {
        return this._fiberTipColorTexture;
    }
    public set fiberTipColorTexture(value: Nullable<BaseTexture>) {
        if (this._fiberTipColorTexture === value) {
            return;
        }
        this._fiberTipColorTexture = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    private _isEnabled = false;

    /**
     * Defines the density of fibers for the fabric fuzz effect (number of fibers per unit area).
     */
    private _fiberDensity = 1;
    public get fiberDensity(): number {
        return this._fiberDensity;
    }
    public set fiberDensity(value: number) {
        if (this._fiberDensity === value) {
            return;
        }
        this._fiberDensity = value;
        const fuzzRenderer = this._material.getScene().fabricFuzzRenderer;
        if (fuzzRenderer && this._material instanceof OpenPBRMaterial) {
            fuzzRenderer.updateDensityForMaterial(this._material);
        }
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * The opacity of the shadows.
     */
    @serialize()
    private _fiberSegments: number = 10.0;
    public get fiberSegments(): number {
        return this._fiberSegments;
    }
    public set fiberSegments(value: number) {
        if (this._fiberSegments === value) {
            return;
        }
        this._fiberSegments = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberRadius: number = 0.01;
    public get fiberRadius(): number {
        return this._fiberRadius;
    }
    public set fiberRadius(value: number) {
        if (this._fiberRadius === value) {
            return;
        }
        this._fiberRadius = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberTaper: number = 0.0;
    public get fiberTaper(): number {
        return this._fiberTaper;
    }
    public set fiberTaper(value: number) {
        if (this._fiberTaper === value) {
            return;
        }
        this._fiberTaper = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberTaperStart: number = 0.0;
    public get fiberTaperStart(): number {
        return this._fiberTaperStart;
    }
    public set fiberTaperStart(value: number) {
        if (this._fiberTaperStart === value) {
            return;
        }
        this._fiberTaperStart = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberLength: number = 1.0;
    public get fiberLength(): number {
        return this._fiberLength;
    }
    public set fiberLength(value: number) {
        if (this._fiberLength === value) {
            return;
        }
        this._fiberLength = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberLengthVariation: number = 0.0;
    public get fiberLengthVariation(): number {
        return this._fiberLengthVariation;
    }
    public set fiberLengthVariation(value: number) {
        if (this._fiberLengthVariation === value) {
            return;
        }
        this._fiberLengthVariation = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberTilt: number = 0.0;
    public get fiberTilt(): number {
        return this._fiberTilt;
    }
    public set fiberTilt(value: number) {
        if (this._fiberTilt === value) {
            return;
        }
        this._fiberTilt = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberCurl: number = 0.0;
    public get fiberCurl(): number {
        return this._fiberCurl;
    }
    public set fiberCurl(value: number) {
        if (this._fiberCurl === value) {
            return;
        }
        this._fiberCurl = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberRotation: number = 0.0;
    public get fiberRotation(): number {
        return this._fiberRotation;
    }
    public set fiberRotation(value: number) {
        if (this._fiberRotation === value) {
            return;
        }
        this._fiberRotation = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberRotationVariation: number = 0.0;
    public get fiberRotationVariation(): number {
        return this._fiberRotationVariation;
    }
    public set fiberRotationVariation(value: number) {
        if (this._fiberRotationVariation === value) {
            return;
        }
        this._fiberRotationVariation = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberChaos: number = 0.0;
    public get fiberChaos(): number {
        return this._fiberChaos;
    }
    public set fiberChaos(value: number) {
        if (this._fiberChaos === value) {
            return;
        }
        this._fiberChaos = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberTipColor: Color3 = new Color3(1, 1, 1);
    public get fiberTipColor(): Color3 {
        return this._fiberTipColor;
    }
    public set fiberTipColor(value: Color3) {
        if (this._fiberTipColor === value) {
            return;
        }
        this._fiberTipColor = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _fiberTipColorBlend: number = 0.0;
    public get fiberTipColorBlend(): number {
        return this._fiberTipColorBlend;
    }
    public set fiberTipColorBlend(value: number) {
        if (this._fiberTipColorBlend === value) {
            return;
        }
        this._fiberTipColorBlend = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    @serialize()
    private _surfaceMeshToWorldMatrix: Nullable<Matrix> = null;
    public get surfaceMeshToWorldMatrix(): Nullable<Matrix> {
        return this._surfaceMeshToWorldMatrix;
    }
    public set surfaceMeshToWorldMatrix(value: Nullable<Matrix>) {
        if (this._surfaceMeshToWorldMatrix === value) {
            return;
        }
        this._surfaceMeshToWorldMatrix = value;
        this._markAllSubMeshesAsTexturesDirty();
    }

    /**
     * Defines if the plugin is enabled in the material.
     */
    @serialize()
    @expandToProperty("_markAllSubMeshesAsTexturesDirty")
    public isEnabled = false;

    protected _markAllSubMeshesAsTexturesDirty(): void {
        this._enable(this._isEnabled);
        this._internalMarkAllSubMeshesAsTexturesDirty();
    }

    private _internalMarkAllSubMeshesAsTexturesDirty: () => void;

    /**
     * Gets a boolean indicating that the plugin is compatible with a give shader language.
     * @returns true if the plugin is compatible with the shader language
     */
    public override isCompatible(): boolean {
        return true;
    }

    constructor(material: Material) {
        super(material, FabricFuzzPluginMaterial.Name, 310, new MaterialFabricFuzzRenderDefines());
        this._internalMarkAllSubMeshesAsTexturesDirty = material._dirtyCallbacks[Constants.MATERIAL_TextureDirtyFlag];
    }

    public override prepareDefines(defines: MaterialFabricFuzzRenderDefines) {
        // defines.FABRIC_FUZZ = this._isEnabled;
        // defines.MAINUV1 = true; // The fiber mesh will always have uvs.
        // defines.UV1 = true; // The fiber mesh will always have uvs.
        // defines._needUVs = true;
    }

    public override prepareDefinesBeforeAttributes(defines: MaterialFabricFuzzRenderDefines, scene: Scene, mesh: AbstractMesh) {
        // Check if this mesh is a fiber instance mesh
        const isFiberMesh = mesh.name === "fabric_fuzz_fiber_instance";
        defines.FABRIC_FUZZ = this._isEnabled && isFiberMesh;
        if (isFiberMesh && this._isEnabled) {
            // There are certain material features that don't make sense for fiber meshes such as per-fragment normal mapping and fuzz/sheen.
            delete defines.GEOMETRY_NORMAL;
            delete defines.FUZZ;
        }
        // Set texture defines
        defines.FABRIC_FUZZ_DENSITY_TEXTURE = !!this._fiberDensityTexture && this._fiberDensityTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_LENGTH_TEXTURE = !!this._fiberLengthTexture && this._fiberLengthTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_RADIUS_TEXTURE = !!this._fiberRadiusTexture && this._fiberRadiusTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_TILT_TEXTURE = !!this._fiberTiltTexture && this._fiberTiltTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_CHAOS_TEXTURE = !!this._fiberChaosTexture && this._fiberChaosTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_CURL_TEXTURE = !!this._fiberCurlTexture && this._fiberCurlTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_TAPER_TEXTURE = !!this._fiberTaperTexture && this._fiberTaperTexture.isReadyOrNotBlocking();
        defines.FABRIC_FUZZ_TIP_COLOR_TEXTURE = !!this._fiberTipColorTexture && this._fiberTipColorTexture.isReadyOrNotBlocking();
        defines._needUVs = true;
    }

    public override getClassName() {
        return "FabricFuzzPluginMaterial";
    }

    public override getUniforms() {
        return {
            ubo: [
                { name: "surfaceMeshToWorld", size: 16, type: "mat4" },
                { name: "fiberSegments", size: 1, type: "float" },
                { name: "fiberLength", size: 1, type: "float" },
                { name: "fiberLengthVariation", size: 1, type: "float" },
                { name: "fiberRadius", size: 1, type: "float" },
                { name: "fiberRotation", size: 1, type: "float" },
                { name: "fiberRotationVariation", size: 1, type: "float" },
                { name: "fiberTilt", size: 1, type: "float" },
                { name: "fiberCurl", size: 1, type: "float" },
                { name: "fiberChaos", size: 1, type: "float" },
                { name: "fiberTaper", size: 1, type: "float" },
                { name: "fiberTaperStart", size: 1, type: "float" },
                { name: "fiberTipColor", size: 3, type: "vec3" },
                { name: "fiberTipColorBlend", size: 1, type: "float" },
            ],
            vertex: `
                // Fiber constants
                uniform mat4 surfaceMeshToWorld;
                uniform float fiberSegments;
                uniform float fiberLength;
                uniform float fiberLengthVariation;
                uniform float fiberRadius;
                uniform float fiberRotation;
                uniform float fiberRotationVariation;
                uniform float fiberTilt;
                uniform float fiberCurl;
                uniform float fiberChaos;
                uniform float fiberTaper;
                uniform float fiberTaperStart;
            `,
            fragment: `
                // Fiber constants
                uniform vec3 fiberTipColor;
                uniform float fiberTipColorBlend;
            `,
        };
    }

    public override getSamplers(samplers: string[]) {
        samplers.push("ffPositionSeedTexture"); // Stores local positions on the mesh and random seed for each fiber
        samplers.push("ffNormalTexture"); // Stores the surface normal where each fiber is rooted
        samplers.push("ffUVTexture"); // Stores the UV coordinates where each fiber is rooted
        samplers.push("ffTangentTexture"); // Stores the surface tangent at each fiber root

        // Fiber parameter textures
        samplers.push("fiberDensityTexture");
        samplers.push("fiberLengthTexture");
        samplers.push("fiberRadiusTexture");
        samplers.push("fiberTiltTexture");
        samplers.push("fiberChaosTexture");
        samplers.push("fiberCurlTexture");
        samplers.push("fiberTaperTexture");
        samplers.push("fiberTipColorTexture");
    }

    public override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh) {
        if (this._isEnabled) {
            // Find offset into the data textures for this submesh
            uniformBuffer.bindTexture("ffPositionSeedTexture", this.positionSeedTexture);
            uniformBuffer.bindTexture("ffNormalTexture", this.normalTexture);
            uniformBuffer.bindTexture("ffUVTexture", this.uvTexture);
            uniformBuffer.bindTexture("ffTangentTexture", this.tangentTexture);

            // Bind fiber parameter textures
            if (this._fiberDensityTexture && this._fiberDensityTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberDensityTexture", this._fiberDensityTexture.getInternalTexture());
            }
            if (this._fiberLengthTexture && this._fiberLengthTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberLengthTexture", this._fiberLengthTexture.getInternalTexture());
            }
            if (this._fiberRadiusTexture && this._fiberRadiusTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberRadiusTexture", this._fiberRadiusTexture.getInternalTexture());
            }
            if (this._fiberTiltTexture && this._fiberTiltTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberTiltTexture", this._fiberTiltTexture.getInternalTexture());
            }
            if (this._fiberChaosTexture && this._fiberChaosTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberChaosTexture", this._fiberChaosTexture.getInternalTexture());
            }
            if (this._fiberCurlTexture && this._fiberCurlTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberCurlTexture", this._fiberCurlTexture.getInternalTexture());
            }
            if (this._fiberTaperTexture && this._fiberTaperTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberTaperTexture", this._fiberTaperTexture.getInternalTexture());
            }
            if (this._fiberTipColorTexture && this._fiberTipColorTexture.isReadyOrNotBlocking()) {
                uniformBuffer.bindTexture("fiberTipColorTexture", this._fiberTipColorTexture.getInternalTexture());
            }

            uniformBuffer.updateMatrix("surfaceMeshToWorld", this._surfaceMeshToWorldMatrix ?? Matrix.IdentityReadOnly);
            uniformBuffer.updateFloat("fiberSegments", this.fiberSegments);
            uniformBuffer.updateFloat("fiberRadius", this.fiberRadius);
            uniformBuffer.updateFloat("fiberTaper", this.fiberTaper);
            uniformBuffer.updateFloat("fiberTaperStart", this.fiberTaperStart);
            uniformBuffer.updateFloat("fiberLength", this.fiberLength);
            uniformBuffer.updateFloat("fiberLengthVariation", this.fiberLengthVariation);
            uniformBuffer.updateFloat("fiberTilt", this.fiberTilt);
            uniformBuffer.updateFloat("fiberCurl", this.fiberCurl);
            uniformBuffer.updateFloat("fiberRotation", this.fiberRotation);
            uniformBuffer.updateFloat("fiberRotationVariation", this.fiberRotationVariation);
            uniformBuffer.updateFloat("fiberChaos", this.fiberChaos);
            uniformBuffer.updateColor3("fiberTipColor", this.fiberTipColor);
            uniformBuffer.updateFloat("fiberTipColorBlend", this.fiberTipColorBlend);
        }
    }

    public override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage) {
        const vert = {
            CUSTOM_VERTEX_DEFINITIONS: `
            #ifdef FABRIC_FUZZ
                uniform sampler2D ffPositionSeedTexture;
                uniform sampler2D ffNormalTexture;
                uniform sampler2D ffUVTexture;
                #ifdef FABRIC_FUZZ_TANGENTS
                    uniform sampler2D ffTangentTexture;
                #endif
                
                // Fiber parameter textures
                #ifdef FABRIC_FUZZ_DENSITY_TEXTURE
                    uniform sampler2D fiberDensityTexture;
                #endif
                #ifdef FABRIC_FUZZ_LENGTH_TEXTURE
                    uniform sampler2D fiberLengthTexture;
                #endif
                #ifdef FABRIC_FUZZ_RADIUS_TEXTURE
                    uniform sampler2D fiberRadiusTexture;
                #endif
                #ifdef FABRIC_FUZZ_TILT_TEXTURE
                    uniform sampler2D fiberTiltTexture;
                #endif
                #ifdef FABRIC_FUZZ_CHAOS_TEXTURE
                    uniform sampler2D fiberChaosTexture;
                #endif
                #ifdef FABRIC_FUZZ_CURL_TEXTURE
                    uniform sampler2D fiberCurlTexture;
                #endif
                #ifdef FABRIC_FUZZ_TAPER_TEXTURE
                    uniform sampler2D fiberTaperTexture;
                #endif
                
                // Varyings for passing data to the fragment shader
                varying vec3 vFiberBasisX;
                varying vec3 vFiberBasisZ;
                varying vec2 vFiberUV;
                varying float vTipColorBlend;

                // Read the position or normal for the current instance (gl_InstanceID)
                vec4 readFiberInstanceData(sampler2D dataTexture) {
                    // Get the ID of the current instance
                    float instanceId = float(gl_InstanceID);
                    float size = float(textureSize(dataTexture, 0).x);
                    
                    // Calculate UV coordinate (we are sampling from a 2D texture)
                    float u = mod(instanceId, size) / size;
                    float v = floor(instanceId / size) / size;

                    // Sample the texture.
                    return texture2D(dataTexture, vec2(u + 0.5/size, v + 0.5/size)); // Add 0.5/size for pixel center
                }

                #ifndef FABRIC_FUZZ_USE_TANGENT
                    /**
                     * Robustly creates an orthonormal basis matrix for the fiber instance
                     * where the Y-axis (fiber length) is aligned with the surface normal.
                     */
                    mat3 createOrthoMatrix(vec3 surfaceNormal) {
                        // The new Y-axis (fiber length) is the surface Normal
                        vec3 newY = surfaceNormal;

                        // 1. Calculate a robust X-axis (Tangent)
                        // Pick a temporary vector that is NOT parallel to the normal (usually X or Z)
                        vec3 tempVector = abs(newY.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                        
                        // Use Gram-Schmidt process to find X-axis perpendicular to Y
                        vec3 newX = normalize(cross(newY, tempVector));

                        // 2. Calculate the Z-axis (Binormal), which is perpendicular to X and Y
                        vec3 newZ = cross(newX, newY);
                        
                        // 3. Combine Translation, Rotation (Basis), and Scale into the final 4x4 matrix
                        mat3 finalMatrix = mat3(1.0);
                        finalMatrix[0].xyz = newX;
                        finalMatrix[1].xyz = newY; 
                        finalMatrix[2].xyz = newZ;

                        return finalMatrix;
                    }
                #endif
                
                // Random Number Generation
                uint rngState;

                void initRNG(float seed) {
                    // Manual float-to-uint conversion for maximum compatibility
                    int i = int(seed * 10000.0);
                    uint uintSeed = uint(abs(i));
                    
                    // Mix the bits to improve seed quality
                    uintSeed = (uintSeed ^ 61u) ^ (uintSeed >> 16u);
                    uintSeed *= 9u;
                    uintSeed = uintSeed ^ (uintSeed >> 4u);
                    uintSeed *= 0x27d4eb2du;
                    uintSeed = uintSeed ^ (uintSeed >> 15u);
                    
                    rngState = uintSeed;
                }

                uint randUint() {
                    // Linear Congruential Generator (same constants as glibc)
                    const uint LCG_A = 1664525u;
                    const uint LCG_C = 1013904223u;
                    rngState = (LCG_A * rngState + LCG_C);
                    return rngState;
                }

                float randFloat() {
                    const float RCP_UINT_MAX = 2.3283064365386963e-10; // 1.0 / (2^32)
                    return float(randUint()) * RCP_UINT_MAX;
                }
            #endif
            `,
            CUSTOM_VERTEX_MAIN_BEGIN: `
            #ifdef FABRIC_FUZZ
                // Read data for the current instance
                vec4 positionSeedData = readFiberInstanceData(ffPositionSeedTexture);
                vec3 ffSurfaceNormal = readFiberInstanceData(ffNormalTexture).xyz;
                vec4 ffSurfaceUVData = readFiberInstanceData(ffUVTexture);
                #ifdef FABRIC_FUZZ_TANGENTS
                    vec4 tangentData = readFiberInstanceData(ffTangentTexture);
                #endif
            #endif
            `,
            CUSTOM_VERTEX_UPDATE_WORLDPOS: `
            #ifdef FABRIC_FUZZ
                vec3 rootPos = positionSeedData.xyz;
                float seed = positionSeedData.w;
                initRNG(seed);

                #ifdef UV1
                    vec2 ffSurfaceUV1 = ffSurfaceUVData.xy;
                #endif
                #ifdef UV2
                    vec2 ffSurfaceUV2 = ffSurfaceUVData.zw;
                #endif
                
                // Sample parameter textures to modulate fiber properties
                float texDensity = 1.0;
                float texLength = 1.0;
                float texRadius = 1.0;
                float texTilt = 1.0;
                float texChaos = 1.0;
                float texCurl = 1.0;
                float texTaper = 1.0;
                float texTipColorBlend = 1.0;
                
                #ifdef FABRIC_FUZZ_DENSITY_TEXTURE
                    #ifdef UV1
                        texDensity = texture2D(fiberDensityTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                #ifdef FABRIC_FUZZ_LENGTH_TEXTURE
                    #ifdef UV1
                        texLength = texture2D(fiberLengthTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                #ifdef FABRIC_FUZZ_RADIUS_TEXTURE
                    #ifdef UV1
                        texRadius = texture2D(fiberRadiusTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                #ifdef FABRIC_FUZZ_TILT_TEXTURE
                    #ifdef UV1
                        texTilt = texture2D(fiberTiltTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                #ifdef FABRIC_FUZZ_CHAOS_TEXTURE
                    #ifdef UV1
                        texChaos = texture2D(fiberChaosTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                #ifdef FABRIC_FUZZ_CURL_TEXTURE
                    #ifdef UV1
                        texCurl = texture2D(fiberCurlTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                #ifdef FABRIC_FUZZ_TAPER_TEXTURE
                    #ifdef UV1
                        texTaper = texture2D(fiberTaperTexture, ffSurfaceUV1).r;
                    #endif
                #endif
                
                // Apply texture modulation to parameters
                float modifiedLength = fiberLength * texLength;
                float modifiedRadius = fiberRadius * texRadius;
                float modifiedTilt = fiberTilt * texTilt;
                float modifiedChaos = fiberChaos * texChaos;
                float modifiedCurl = fiberCurl * texCurl;
                float modifiedTaper = fiberTaper * texTaper;
                
                #ifdef FABRIC_FUZZ_TANGENTS
                    vFiberBasisX = tangentData.xyz;
                    vFiberBasisZ = cross(ffSurfaceNormal, vFiberBasisX) * tangentData.w;
                #else
                    {
                    mat3 instanceMatrix = createOrthoMatrix(ffSurfaceNormal);
                    vFiberBasisX = instanceMatrix[0].xyz; 
                    vFiberBasisZ = instanceMatrix[2].xyz;
                    }
                #endif

                // Compute starting direction (tilt + rotation)
                // Apply rotation variation
                float baseRotationAngle = fiberRotation * TWO_PI;
                float rotationOffset = (randFloat() - 0.5) * fiberRotationVariation * TWO_PI;
                float finalRotationAngle = baseRotationAngle + rotationOffset;
                
                // Rotate tangent around normal
                vec3 rotatedTangent = vFiberBasisX * cos(finalRotationAngle) + 
                                    vFiberBasisZ * sin(finalRotationAngle);
                vec3 rotatedBitangent = cross(ffSurfaceNormal, rotatedTangent);
                
                // Apply tilt (angle away from normal toward tangent)
                float tiltAngle = modifiedTilt * HALF_PI;
                vec3 fiberDirection = ffSurfaceNormal * cos(tiltAngle) + 
                                    rotatedTangent * sin(tiltAngle);
                fiberDirection = normalize(vec4(fiberDirection, 0.0) * transpose(surfaceMeshToWorld)).xyz;

                // Extract triangle strip information
                // For a triangle strip: 
                // - The fiber's is 1 unit high so the progress along fiber is position.y (0=root, 1=tip)
                // - position.x is the signed offset from center (-1 to +1)
                float vertexProgress = positionUpdated.y;
                
                uint vertexIndex = uint(vertexProgress * fiberSegments);
                
                // Strip width parameter: -1 = left edge, 0 = center, +1 = right edge
                float stripOffset = positionUpdated.x;  // Assumes strip is in XY plane, offset in X
                
                // Calculate deformed spine position at this vertex
                float baseSegmentLength = modifiedLength / fiberSegments;
                
                vec3 spinePosition = (surfaceMeshToWorld * vec4(rootPos, 1.0)).xyz;
                vec3 currentDirection = fiberDirection;
                
                vec3 stableRight = rotatedTangent;
                vec3 stableBitangent = rotatedBitangent;
                
                float curlAnglePerSegment = modifiedCurl * PI / max(1.0, fiberSegments - 1.0);
                float maxChaosAnglePerSegment = modifiedChaos * HALF_PI;
                
                // Walk through segments up to current vertex
                for (uint seg = 0u; seg < vertexIndex; seg++) {
                    vec3 prevDirection = currentDirection;
                    
                    float segmentLengthVariation = (randFloat() - 0.5) * fiberLengthVariation * baseSegmentLength * 2.0;
                    float segmentLength = baseSegmentLength + segmentLengthVariation;
                    
                    if (curlAnglePerSegment > 0.0) {
                        vec3 curlAxis = normalize(cross(currentDirection, stableBitangent));
                        currentDirection = currentDirection * cos(curlAnglePerSegment) - 
                                        curlAxis * sin(curlAnglePerSegment);
                        currentDirection = normalize(currentDirection);
                    }
                    
                    if (maxChaosAnglePerSegment > 0.0) {
                        float cosMaxChaos = cos(maxChaosAnglePerSegment);
                        float cosChaos = cosMaxChaos + (1.0 - cosMaxChaos) * randFloat();
                        float sinChaos = sqrt(1.0 - cosChaos * cosChaos);
                        float azimuth = TWO_PI * randFloat();
                        
                        vec3 perpendicular1 = normalize(cross(currentDirection, stableBitangent));
                        if (length(perpendicular1) < 0.01) {
                            perpendicular1 = normalize(cross(currentDirection, vec3(0, 1, 0)));
                            if (length(perpendicular1) < 0.01) {
                                perpendicular1 = normalize(cross(currentDirection, vec3(1, 0, 0)));
                            }
                        }
                        vec3 perpendicular2 = cross(currentDirection, perpendicular1);
                        
                        currentDirection = currentDirection * cosChaos + 
                                        perpendicular1 * sinChaos * sin(azimuth) +
                                        perpendicular2 * sinChaos * cos(azimuth);
                        currentDirection = normalize(currentDirection);
                    }
                    
                    // Parallel transport
                    vec3 rotationAxis = cross(prevDirection, currentDirection);
                    float rotationAxisLength = length(rotationAxis);
                    
                    if (rotationAxisLength > 0.0001) {
                        rotationAxis = rotationAxis / rotationAxisLength;
                        float rotationAngle = asin(min(1.0, rotationAxisLength));
                        float cosAngle = cos(rotationAngle);
                        float sinAngle = sin(rotationAngle);
                        
                        vec3 newStableRight = stableRight * cosAngle + 
                                            cross(rotationAxis, stableRight) * sinAngle + 
                                            rotationAxis * dot(rotationAxis, stableRight) * (1.0 - cosAngle);
                        
                        vec3 newStableBitangent = stableBitangent * cosAngle + 
                                                cross(rotationAxis, stableBitangent) * sinAngle + 
                                                rotationAxis * dot(rotationAxis, stableBitangent) * (1.0 - cosAngle);
                        
                        stableRight = normalize(newStableRight);
                        stableBitangent = normalize(newStableBitangent);
                    }
                    
                    spinePosition += currentDirection * segmentLength;
                }

                // Apply tapering to radius based on vertex progress
                float taperProgress = max(0.0, vertexProgress - fiberTaperStart);
                float taperScale = 1.0 - (taperProgress / max(0.001, 1.0 - fiberTaperStart)) * modifiedTaper;
                float currentRadius = modifiedRadius * taperScale;
                
                // Orient strip to face camera (billboard effect)
                vec3 fiberForward = normalize(currentDirection);
                
                // Compute direction from spine to camera
                vec3 toCamera = normalize(vEyePosition.xyz - spinePosition);
                
                // Strip right direction is perpendicular to both fiber forward and to-camera
                vec3 stripRight = normalize(cross(fiberForward, toCamera));
                
                vFiberBasisX = stripRight;
                vFiberBasisZ = cross(fiberForward, stripRight);
                vFiberUV = vec2(stripOffset, vertexProgress);

                // Position vertex along strip width     
                vec3 finalPosition = spinePosition + stripRight * stripOffset * currentRadius;
                // Transform local position to world space
                worldPos = vec4(finalPosition, 1.0);
            #endif
            `,
            CUSTOM_VERTEX_UPDATE_UVS: `
            #ifdef FABRIC_FUZZ
                #ifdef UV1
                    // Use the surface UV as the base
                    uvUpdated = ffSurfaceUV1;
                #endif
                #ifdef UV2
                    uv2Updated = ffSurfaceUV2;
                #endif
                #ifdef MAINUV1
                    // Use the surface UV as the base
                    vMainUV1 = ffSurfaceUV1;
                #endif
                #ifdef MAINUV2
                    // Use the surface UV as the base
                    vMainUV2 = ffSurfaceUV2;
                #endif
            #endif
            `,
        };

        const frag = {
            CUSTOM_FRAGMENT_DEFINITIONS: `
            #ifdef FABRIC_FUZZ
                #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
                    uniform sampler2D fiberTipColorTexture;
                #endif
                varying vec3 vFiberBasisX;
                varying vec3 vFiberBasisZ;
                varying vec2 vFiberUV;
            #endif
            `,
            CUSTOM_FRAGMENT_MAIN_BEGIN: `
            #ifdef FABRIC_FUZZ

                #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
                    #ifdef MAINUV1
                        float texTipColor = texture2D(fiberTipColorTexture, vMainUV1).r;
                    #endif
                #endif
                // Compute lighting based on fiber orientation
                float localX = vFiberUV.x;
                vec3 localCylinderNormal = normalize(vec3(localX, 0.0, 1.0 - abs(localX)));

                // 2. Transform the local normal to world space using the interpolated basis vectors (TBN)
                // Since the local normal only has X and Z components (in local hair space):
                vec3 fiberNormalW = normalize(
                    localCylinderNormal.x * vFiberBasisX +
                    localCylinderNormal.z * vFiberBasisZ 
                );
                // Flip normal based on facing (this is done later in the shader and doesn't work well for fibers so this cancels it out)
                fiberNormalW = gl_FrontFacing ? fiberNormalW : -fiberNormalW;
                // Replace the varying vNormalW with the fiber normal
                #define vNormalW fiberNormalW
                
            #endif
            `,
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
            #ifdef FABRIC_FUZZ
                // Apply tip color blending
                vec3 tipColor = fiberTipColor;
                #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
                    #ifdef MAINUV1
                        tipColor *= texTipColor;
                    #endif
                #endif
                base_color = mix(base_color.rgb, tipColor, vFiberUV.y * fiberTipColorBlend);
            #endif
            `,
        };

        return shaderType === "vertex" ? vert : frag;
    }
    // private _isGLSL(shaderLanguage: ShaderLanguage) {
    //     return shaderLanguage === ShaderLanguage.GLSL;
    // }
}

RegisterClass(`BABYLON.FabricFuzzPluginMaterial`, FabricFuzzPluginMaterial);
