import { MaterialDefines } from "core/Materials/materialDefines";
import { MaterialPluginBase } from "core/Materials/materialPluginBase";
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
import { ShaderLanguage } from "core/Materials/shaderLanguage";
import type { Material } from "core/Materials/material";
import type { AbstractMesh } from "core/Meshes/abstractMesh";
import { Matrix } from "core/Maths/math.vector";
import type { BaseTexture } from "core/Materials/Textures/baseTexture";
import { ShaderStore } from "core/Engines/shaderStore";

import {
    FabricFuzzVertexSamplers as FabricFuzzVertexSamplersGLSL,
    FabricFuzzVertexUniforms as FabricFuzzVertexUniformsGLSL,
    FabricFuzzVertexDeclarations as FabricFuzzVertexDeclarationsGLSL,
    FabricFuzzVertexMainBegin as FabricFuzzVertexMainBeginGLSL,
    FabricFuzzVertexUpdateWorldPos as FabricFuzzVertexUpdateWorldPosGLSL,
    FabricFuzzVertexUpdateUVs as FabricFuzzVertexUpdateUVsGLSL,
    FabricFuzzFragmentDeclarations as FabricFuzzFragmentDeclarationsGLSL,
    FabricFuzzFragmentMainBegin as FabricFuzzFragmentMainBeginGLSL,
    FabricFuzzFragmentBeforeLights as FabricFuzzFragmentBeforeLightsGLSL,
} from "./fabricFuzzShaderCodeGLSL";

import {
    FabricFuzzVertexSamplers as FabricFuzzVertexSamplersWGSL,
    FabricFuzzVertexUniforms as FabricFuzzVertexUniformsWGSL,
    FabricFuzzVertexDeclarations as FabricFuzzVertexDeclarationsWGSL,
    FabricFuzzVertexMainBegin as FabricFuzzVertexMainBeginWGSL,
    FabricFuzzVertexUpdateWorldPos as FabricFuzzVertexUpdateWorldPosWGSL,
    FabricFuzzVertexUpdateUVs as FabricFuzzVertexUpdateUVsWGSL,
    FabricFuzzFragmentDeclarations as FabricFuzzFragmentDeclarationsWGSL,
    FabricFuzzFragmentMainBegin as FabricFuzzFragmentMainBeginWGSL,
    FabricFuzzFragmentBeforeLights as FabricFuzzFragmentBeforeLightsWGSL,
} from "./fabricFuzzShaderCodeWGSL";

/**
 * @internal
 */
class MaterialFabricFuzzRenderDefines extends MaterialDefines {
    public FABRIC_FUZZ = false;
    public FABRIC_FUZZ_TANGENTS = false;
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
 * Plugin used to render the contribution from fabric fuzz fibers.
 */
export class FabricFuzzPluginMaterial extends MaterialPluginBase {
    private static _ShadersRegistered = false;

    /**
     * Registers the fabric fuzz shader code in the shader store for use by other renderers like GeometryBufferRenderer
     */
    private static _RegisterShaders() {
        if (FabricFuzzPluginMaterial._ShadersRegistered) {
            return;
        }
        FabricFuzzPluginMaterial._ShadersRegistered = true;

        // Register the shared shader code as includes (GLSL)
        ShaderStore.IncludesShadersStore["fabricFuzzVertexUniforms"] = FabricFuzzVertexUniformsGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzVertexDeclaration"] = FabricFuzzVertexDeclarationsGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzVertexMainBegin"] = FabricFuzzVertexMainBeginGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzVertexPosition"] = FabricFuzzVertexUpdateWorldPosGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzVertexUpdateUVs"] = FabricFuzzVertexUpdateUVsGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzFragmentDeclaration"] = FabricFuzzFragmentDeclarationsGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzFragmentMainBegin"] = FabricFuzzFragmentMainBeginGLSL;
        ShaderStore.IncludesShadersStore["fabricFuzzFragmentBeforeLights"] = FabricFuzzFragmentBeforeLightsGLSL;

        // Register the shared shader code as includes (WGSL)
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzVertexUniforms"] = FabricFuzzVertexUniformsWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzVertexDeclaration"] = FabricFuzzVertexDeclarationsWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzVertexMainBegin"] = FabricFuzzVertexMainBeginWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzVertexPosition"] = FabricFuzzVertexUpdateWorldPosWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzVertexUpdateUVs"] = FabricFuzzVertexUpdateUVsWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzFragmentDeclaration"] = FabricFuzzFragmentDeclarationsWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzFragmentMainBegin"] = FabricFuzzFragmentMainBeginWGSL;
        ShaderStore.IncludesShadersStoreWGSL["fabricFuzzFragmentBeforeLights"] = FabricFuzzFragmentBeforeLightsWGSL;
    }

    /**
     * Defines the name of the plugin.
     */
    public static readonly Name = "FabricFuzzPluginMaterial";

    /**
     * The texture containing the position and random seed for each fiber.
     */
    public positionSeedTexture: Nullable<BaseTexture> = null;

    /**
     * The texture containing the normal for each fiber.
     */
    public normalTexture: Nullable<BaseTexture> = null;

    /**
     * The texture containing the UV coordinates for each fiber.
     */
    public uvTexture: Nullable<BaseTexture> = null;

    /**
     * The texture containing the tangent at the surface for each fiber.
     */
    public tangentTexture: Nullable<BaseTexture> = null;

    public fiberOffset: number = 0;

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
        const fuzzRenderer = this._material.getScene().fabricFuzzRenderer;
        if (fuzzRenderer && this._material instanceof OpenPBRMaterial) {
            fuzzRenderer.updateSegmentsForMaterial(this._material);
        }
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

        // Register shader includes on first instantiation
        FabricFuzzPluginMaterial._RegisterShaders();
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
        if (this.tangentTexture) {
            defines.FABRIC_FUZZ_TANGENTS = true;
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

    public override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
        const isWGSL = shaderLanguage === ShaderLanguage.WGSL;

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
                { name: "fiberOffset", size: 1, type: "float" },
            ],
            vertex: isWGSL ? `${FabricFuzzVertexUniformsWGSL}\n${FabricFuzzVertexSamplersWGSL}` : `${FabricFuzzVertexUniformsGLSL}\n${FabricFuzzVertexSamplersGLSL}`,
            fragment: isWGSL
                ? `
                // Fiber constants
                uniform fiberTipColor: vec3f;
                uniform fiberTipColorBlend: f32;
            `
                : `
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
            uniformBuffer.bindTexture("ffPositionSeedTexture", this.positionSeedTexture!.getInternalTexture());
            uniformBuffer.bindTexture("ffNormalTexture", this.normalTexture!.getInternalTexture());
            uniformBuffer.bindTexture("ffUVTexture", this.uvTexture!.getInternalTexture());
            if (this.tangentTexture) {
                uniformBuffer.bindTexture("ffTangentTexture", this.tangentTexture!.getInternalTexture());
            }

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
            uniformBuffer.updateFloat("fiberOffset", this.fiberOffset);
        }
    }

    public override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage): Nullable<{ [pointName: string]: string }> {
        const isWGSL = shaderLanguage === ShaderLanguage.WGSL;

        const vert = {
            CUSTOM_VERTEX_UNIFORMS: isWGSL ? FabricFuzzVertexUniformsWGSL : `${FabricFuzzVertexUniformsGLSL}\n${FabricFuzzVertexSamplersGLSL}`,
            CUSTOM_VERTEX_DEFINITIONS: isWGSL ? `${FabricFuzzVertexSamplersWGSL}\n${FabricFuzzVertexDeclarationsWGSL}` : FabricFuzzVertexDeclarationsGLSL,
            CUSTOM_VERTEX_MAIN_BEGIN: isWGSL ? FabricFuzzVertexMainBeginWGSL : FabricFuzzVertexMainBeginGLSL,
            CUSTOM_VERTEX_UPDATE_WORLDPOS: isWGSL ? FabricFuzzVertexUpdateWorldPosWGSL : FabricFuzzVertexUpdateWorldPosGLSL,
            CUSTOM_VERTEX_UPDATE_UVS: isWGSL ? FabricFuzzVertexUpdateUVsWGSL : FabricFuzzVertexUpdateUVsGLSL,
        };

        const frag = {
            CUSTOM_FRAGMENT_DEFINITIONS: isWGSL ? FabricFuzzFragmentDeclarationsWGSL : FabricFuzzFragmentDeclarationsGLSL,
            CUSTOM_FRAGMENT_MAIN_BEGIN: isWGSL ? FabricFuzzFragmentMainBeginWGSL : FabricFuzzFragmentMainBeginGLSL,
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: isWGSL ? FabricFuzzFragmentBeforeLightsWGSL : FabricFuzzFragmentBeforeLightsGLSL,
        };

        return shaderType === "vertex" ? vert : frag;
    }
}

RegisterClass(`BABYLON.FabricFuzzPluginMaterial`, FabricFuzzPluginMaterial);
