import { type Material } from "core/Materials/material";
import { MaterialPluginBase } from "core/Materials/materialPluginBase";
import { MaterialDefines } from "core/Materials/materialDefines";
import { type UniformBuffer } from "core/Materials/uniformBuffer";
import { type InternalTexture } from "core/Materials/Textures/internalTexture";
import { ShaderLanguage } from "core/Materials/shaderLanguage";
import { Constants } from "core/Engines/constants";
import { expandToProperty, serialize } from "core/Misc/decorators";
import { RegisterClass } from "core/Misc/typeStore";
import { OpenPBRMaterial } from "core/Materials/PBR/openpbrMaterial";

/**
 * @internal
 */
class MaterialRtDiffuseGIDefines extends MaterialDefines {
    public RENDER_WITH_RT_DIFFUSE_GI = false;
}

/**
 * Material plugin that reads the ray-traced diffuse GI irradiance texture and
 * adds it (weighted by `base_color`) into `material_surface_ibl` before
 * OpenPBR's final color is assembled — physically correct indirect diffuse weighting.
 *
 * Only compatible with `OpenPBRMaterial`; silently no-ops on all other types.
 * Registered automatically on every scene material by `FrameGraphRtDiffuseGITask`.
 * @internal
 */
export class RtDiffuseGIPluginMaterial extends MaterialPluginBase {
    /** Registered plugin name — used as a stable key in the plugin system. */
    public static readonly Name = "RtDiffuseGI";

    /**
     * The GI irradiance texture (resolved from the frame graph each frame by
     * `FrameGraphRtDiffuseGITask` and assigned here before the raster pass).
     */
    @serialize()
    public textureGIContrib: InternalTexture;

    /** Width of the GI output texture in pixels. */
    @serialize()
    public outputTextureWidth = 1;

    /** Height of the GI output texture in pixels. */
    @serialize()
    public outputTextureHeight = 1;

    private _isEnabled = false;

    /**
     * Enables or disables the GI contribution on this material instance.
     * Setting `false` suppresses the define so the shader skips the GI lookup
     * with zero overhead.
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
     * Checks if this plugin is compatible with the given material
     * @returns Whether the material is compatible
     */
    public override isCompatible(): boolean {
        return this._material instanceof OpenPBRMaterial;
    }

    constructor(material: Material) {
        super(material, RtDiffuseGIPluginMaterial.Name, 315, new MaterialRtDiffuseGIDefines());

        this._internalMarkAllSubMeshesAsTexturesDirty = material._dirtyCallbacks[Constants.MATERIAL_TextureDirtyFlag];
    }

    /** @inheritDoc */
    public override prepareDefines(defines: MaterialRtDiffuseGIDefines): void {
        // Suppress the define until the texture is actually available — avoids a
        // bind group crash on the first frame before the GI trace pass has run.
        defines.RENDER_WITH_RT_DIFFUSE_GI = this._isEnabled && this._material instanceof OpenPBRMaterial && !!this.textureGIContrib;
    }

    /** @inheritDoc */
    public override getClassName(): string {
        return "RtDiffuseGIPluginMaterial";
    }

    /** @inheritDoc */
    public override getUniforms() {
        return {
            ubo: [{ name: "rtGIOutputSize", size: 2, type: "vec2" }],
            fragment: `#ifdef RENDER_WITH_RT_DIFFUSE_GI
                    uniform vec2 rtGIOutputSize;
                #endif`,
        };
    }

    /** @inheritDoc */
    public override getSamplers(samplers: string[]): void {
        samplers.push("rtGITexture");
    }

    /** @inheritDoc */
    public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
        if (this._isEnabled && this.textureGIContrib) {
            uniformBuffer.bindTexture("rtGITexture", this.textureGIContrib);
            uniformBuffer.updateFloat2("rtGIOutputSize", this.outputTextureWidth, this.outputTextureHeight);
        }
    }

    /** @inheritDoc */
    public override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage): { [name: string]: string } | null {
        if (shaderType !== "fragment") {
            return null;
        }

        if (shaderLanguage === ShaderLanguage.WGSL) {
            return {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                CUSTOM_FRAGMENT_DEFINITIONS: `
                #ifdef RENDER_WITH_RT_DIFFUSE_GI
                    var rtGITextureSampler: sampler;
                    var rtGITexture: texture_2d<f32>;

                    fn computeRtGIIndirect() -> vec3f {
                        let uv = fragmentInputs.position.xy / uniforms.rtGIOutputSize;
                        return textureSample(rtGITexture, rtGITextureSampler, uv).rgb;
                    }
                #endif
            `,

                // Inject into material_surface_ibl before finalColor is assembled.
                // base_color is the OpenPBR diffuse albedo (already resolved from
                // texture + tint weight at this point in the shader).
                // eslint-disable-next-line @typescript-eslint/naming-convention
                CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
                #ifdef RENDER_WITH_RT_DIFFUSE_GI
                    material_surface_ibl += computeRtGIIndirect() * base_color;
                #endif
            `,
            };
        }

        // GLSL path — GI compute is WebGPU-only, but the plugin must compile
        // cleanly on WebGL so the material doesn't break on non-WebGPU devices.
        return {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            CUSTOM_FRAGMENT_DEFINITIONS: `
                #ifdef RENDER_WITH_RT_DIFFUSE_GI
                    uniform sampler2D rtGITexture;

                    vec3 computeRtGIIndirect() {
                        vec2 uv = gl_FragCoord.xy / rtGIOutputSize;
                        return texture2D(rtGITexture, uv).rgb;
                    }
                #endif
            `,

            // eslint-disable-next-line @typescript-eslint/naming-convention
            CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
                #ifdef RENDER_WITH_RT_DIFFUSE_GI
                    material_surface_ibl += computeRtGIIndirect() * base_color;
                #endif
            `,
        };
    }
}

RegisterClass("BABYLON.RtDiffuseGIPluginMaterial", RtDiffuseGIPluginMaterial);
