import { SerializationHelper, serialize, expandToProperty, serializeAsTexture, serializeAsColor3 } from "../../Misc/decorators";
import { EffectFallbacks } from "../../Materials/effect";
import { UniformBuffer } from "../../Materials/uniformBuffer";
import { Scene } from "../../scene";
import { MaterialFlags } from "../../Materials/materialFlags";
import { MaterialHelper } from "../../Materials/materialHelper";
import { BaseTexture } from "../../Materials/Textures/baseTexture";
import { IAnimatable } from "../../Misc/tools";
import { Nullable } from "../../types";
import { Color3 } from '../../Maths/math';

/**
 * @hidden
 */
export interface IMaterialTransparencyDefines {
    TRANSPARENCY: boolean;
    TRANSPARENCY_TEXTURE: boolean;
    TRANSPARENCY_TEXTUREDIRECTUV: number;
    TRANSPARENCYRGB: boolean;
    TRANSPARENCY_FRONT_DEPTH: boolean;
    TRANSPARENCY_BACK_DEPTH: boolean;
    TRANSPARENCY_INTERIOR: boolean;
    /** @hidden */
    _areTexturesDirty: boolean;
}

/**
 * Define the code related to the Transparency parameters of the pbr material.
 */
export class PBRTransparencyConfiguration {

    @serialize()
    private _isEnabled = false;
    /**
     * Defines if the material uses transparency.
     */
    @expandToProperty("_markAllSubMeshesAsTexturesDirty")
    public isEnabled = false;

    /**
     * Defines the transparency factor.
     */
    @serialize()
    public factor = 1;

    @serializeAsTexture()
    private _texture: Nullable<BaseTexture> = null;
    /**
     */
    @expandToProperty("_markAllSubMeshesAsTexturesDirty")
    public texture: Nullable<BaseTexture> = null;

    @serializeAsTexture()
    private _backDepthTexture: Nullable<BaseTexture> = null;
    /**
     */
    @expandToProperty("_markAllSubMeshesAsTexturesDirty")
    public backDepthTexture: Nullable<BaseTexture> = null;

    @serializeAsTexture()
    private _frontDepthTexture: Nullable<BaseTexture> = null;
    /**
     */
    @expandToProperty("_markAllSubMeshesAsTexturesDirty")
    public frontDepthTexture: Nullable<BaseTexture> = null;

    @serializeAsColor3()
    public interiorColor = Color3.White();

    @serialize()
    public interiorDensity = 0;

    /** @hidden */
    private _internalMarkAllSubMeshesAsTexturesDirty: () => void;

    /** @hidden */
    public _markAllSubMeshesAsTexturesDirty(): void {
        this._internalMarkAllSubMeshesAsTexturesDirty();
    }

    /**
     * Instantiate a new instance of transparency configuration.
     * @param markAllSubMeshesAsTexturesDirty Callback to flag the material to dirty
     */
    constructor(markAllSubMeshesAsTexturesDirty: () => void) {
        this._internalMarkAllSubMeshesAsTexturesDirty = markAllSubMeshesAsTexturesDirty;
    }

    /**
     * Specifies that the submesh is ready to be used.
     * @param defines the list of "defines" to update.
     * @param scene defines the scene the material belongs to.
     * @returns - boolean indicating that the submesh is ready or not.
     */
    public isReadyForSubMesh(defines: IMaterialTransparencyDefines, scene: Scene): boolean {
        if (defines._areTexturesDirty) {
            if (scene.texturesEnabled) {
                if (this._texture && MaterialFlags.TransparencyTextureEnabled) {
                    if (!this._texture.isReadyOrNotBlocking()) {
                        return false;
                    }
                }
                if (this._frontDepthTexture && MaterialFlags.TransparencyFrontDepthEnabled) {
                    if (!this._frontDepthTexture.isReadyOrNotBlocking()) {
                        return false;
                    }
                }
                if (this._backDepthTexture && MaterialFlags.TransparencyBackDepthEnabled) {
                    if (!this._backDepthTexture.isReadyOrNotBlocking()) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    /**
     * Checks to see if a texture is used in the material.
     * @param defines the list of "defines" to update.
     * @param scene defines the scene the material belongs to.
     */
    public prepareDefines(defines: IMaterialTransparencyDefines, scene: Scene): void {
        if (this._isEnabled) {
            defines.TRANSPARENCY = this._isEnabled;
            if (defines._areTexturesDirty) {
                if (scene.texturesEnabled) {
                    if (this._texture && MaterialFlags.TransparencyTextureEnabled) {
                        MaterialHelper.PrepareDefinesForMergedUV(this._texture, defines, "TRANSPARENCY_TEXTURE");
                        defines.TRANSPARENCYRGB = this._texture.getAlphaFromRGB;
                    } else {
                        defines.TRANSPARENCY_TEXTURE = false;
                    }
                    if (this._frontDepthTexture && MaterialFlags.TransparencyFrontDepthEnabled) {
                        MaterialHelper.PrepareDefinesForMergedUV(this._frontDepthTexture, defines, "TRANSPARENCY_FRONT_DEPTH");
                    } else {
                        defines.TRANSPARENCY_FRONT_DEPTH = false;
                    }
                    if (this._backDepthTexture && MaterialFlags.TransparencyBackDepthEnabled) {
                        MaterialHelper.PrepareDefinesForMergedUV(this._backDepthTexture, defines, "TRANSPARENCY_BACK_DEPTH");
                    } else {
                        defines.TRANSPARENCY_BACK_DEPTH = false;
                    }
                }
            }
            if (this.interiorDensity > 0) {
                defines.TRANSPARENCY_INTERIOR = true;
            }
        }
        else {
            defines.TRANSPARENCY = false;
            defines.TRANSPARENCY_TEXTURE = false;
            defines.TRANSPARENCY_FRONT_DEPTH = false;
            defines.TRANSPARENCY_BACK_DEPTH = false;
            defines.TRANSPARENCY_INTERIOR = false;
        }
    }

    /**
     * Binds the material data.
     * @param uniformBuffer defines the Uniform buffer to fill in.
     * @param scene defines the scene the material belongs to.
     * @param isFrozen defines wether the material is frozen or not.
     */
    public bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, isFrozen: boolean): void {
        if (!uniformBuffer.useUbo || !isFrozen || !uniformBuffer.isSync) {
            let depthTextureWidth = 1;
            let depthTextureHeight = 1;
            if (this._frontDepthTexture && MaterialFlags.TransparencyFrontDepthEnabled) {
                depthTextureHeight = scene.getEngine().getRenderHeight();
                depthTextureWidth = scene.getEngine().getRenderWidth();
                MaterialHelper.BindTextureMatrix(this._frontDepthTexture, uniformBuffer, "frontDepthTexture");
                if (this._backDepthTexture && MaterialFlags.TransparencyBackDepthEnabled) {
                    MaterialHelper.BindTextureMatrix(this._backDepthTexture, uniformBuffer, "backDepthTexture");
                }
                const camera = scene.activeCamera;
                if (camera) {
                    uniformBuffer.updateFloat4("transparencyDepthValues", camera.minZ, camera.minZ + camera.maxZ, depthTextureWidth, depthTextureHeight);
                }
            } else {
                const camera = scene.activeCamera;
                if (camera) {
                    uniformBuffer.updateFloat4("transparencyDepthValues", camera.minZ, camera.minZ + camera.maxZ, 0, 0);
                }
            }
            if (this._texture && MaterialFlags.TransparencyTextureEnabled) {
                uniformBuffer.updateFloat2("vTransparencyInfos", this._texture.coordinatesIndex, this._texture.level);
                MaterialHelper.BindTextureMatrix(this._texture, uniformBuffer, "transparency");
            }

            // Transparency
            uniformBuffer.updateFloat("transparency",
                this.factor);

            if (this.interiorDensity > 0) {
                uniformBuffer.updateFloat4("vInteriorTransparency", this.interiorColor.r,
                    this.interiorColor.g,
                    this.interiorColor.b,
                    this.interiorDensity);
            }
        }

        // Textures
        if (scene.texturesEnabled) {
            if (this._texture && MaterialFlags.TransparencyTextureEnabled) {
                uniformBuffer.setTexture("transparencySampler", this._texture);
            }
            if (this._backDepthTexture && MaterialFlags.TransparencyBackDepthEnabled) {
                const camera = scene.activeCamera;
                if (camera) {
                    const depthTextureHeight = this._backDepthTexture.getSize().height;
                    const depthTextureWidth = this._backDepthTexture.getSize().width;
                    uniformBuffer.updateFloat4("transparencyDepthValues", camera.minZ, camera.minZ + camera.maxZ, depthTextureWidth, depthTextureHeight);
                }
                uniformBuffer.setTexture("backDepthTexture", this._backDepthTexture);
            } else {
                const camera = scene.activeCamera;
                if (camera) {
                    uniformBuffer.updateFloat4("transparencyDepthValues", camera.minZ, camera.minZ + camera.maxZ, 0, 0);
                }
            }
            if (this._frontDepthTexture && MaterialFlags.TransparencyFrontDepthEnabled) {
                uniformBuffer.setTexture("frontDepthTexture", this._frontDepthTexture);
            }
        }
    }

    /**
     * Checks to see if a texture is used in the material.
     * @param texture - Base texture to use.
     * @returns - Boolean specifying if a texture is used in the material.
     */
    public hasTexture(texture: BaseTexture): boolean {
        if (this._texture === texture || this._frontDepthTexture === texture || this._backDepthTexture === texture) {
            return true;
        }

        return false;
    }

    /**
     * Returns an array of the actively used textures.
     * @param activeTextures Array of BaseTextures
     */
    public getActiveTextures(activeTextures: BaseTexture[]): void {
        if (this._texture) {
            activeTextures.push(this._texture);
        }
        if (this._frontDepthTexture) {
            activeTextures.push(this._frontDepthTexture);
        }
        if (this._backDepthTexture) {
            activeTextures.push(this._backDepthTexture);
        }
    }

    /**
     * Returns the animatable textures.
     * @param animatables Array of animatable textures.
     */
    public getAnimatables(animatables: IAnimatable[]): void {
        if (this._texture && this._texture.animations && this._texture.animations.length > 0) {
            animatables.push(this._texture);
        }
        if (this._frontDepthTexture && this._frontDepthTexture.animations && this._frontDepthTexture.animations.length > 0) {
            animatables.push(this._frontDepthTexture);
        }
        if (this._backDepthTexture && this._backDepthTexture.animations && this._backDepthTexture.animations.length > 0) {
            animatables.push(this._backDepthTexture);
        }
    }

    /**
     * Disposes the resources of the material.
     * @param forceDisposeTextures - Forces the disposal of all textures.
     */
    public dispose(forceDisposeTextures?: boolean): void {
        if (forceDisposeTextures) {
            if (this._texture) {
                this._texture.dispose();
            }
            if (this._frontDepthTexture) {
                this._frontDepthTexture.dispose();
            }
            if (this._backDepthTexture) {
                this._backDepthTexture.dispose();
            }
        }
    }

    /**
    * Get the current class name of the texture useful for serialization or dynamic coding.
    * @returns "PBRTransparencyConfiguration"
    */
    public getClassName(): string {
        return "PBRTransparencyConfiguration";
    }

    /**
     * Add fallbacks to the effect fallbacks list.
     * @param defines defines the Base texture to use.
     * @param fallbacks defines the current fallback list.
     * @param currentRank defines the current fallback rank.
     * @returns the new fallback rank.
     */
    public static AddFallbacks(defines: IMaterialTransparencyDefines, fallbacks: EffectFallbacks, currentRank: number): number {
        if (defines.TRANSPARENCY) {
            fallbacks.addFallback(currentRank++, "TRANSPARENCY");
        }
        return currentRank;
    }

    /**
     * Add the required uniforms to the current list.
     * @param uniforms defines the current uniform list.
     */
    public static AddUniforms(uniforms: string[]): void {
        uniforms.push("transparency", "vTransparencyInfos", "transparencyMatrix", "transparencyDepthValues", "vInteriorTransparency");
    }

    /**
     * Add the required uniforms to the current buffer.
     * @param uniformBuffer defines the current uniform buffer.
     */
    public static PrepareUniformBuffer(uniformBuffer: UniformBuffer): void {
        uniformBuffer.addUniform("transparency", 1);
        uniformBuffer.addUniform("vTransparencyInfos", 2);
        uniformBuffer.addUniform("transparencyMatrix", 16);
        uniformBuffer.addUniform("transparencyDepthValues", 4);
        uniformBuffer.addUniform("vInteriorTransparency", 4);
    }

    /**
     * Add the required samplers to the current list.
     * @param samplers defines the current sampler list.
     */
    public static AddSamplers(samplers: string[]): void {
        samplers.push("transparencySampler");
        samplers.push("frontDepthTexture");
        samplers.push("backDepthTexture");
    }

    /**
     * Makes a duplicate of the current configuration into another one.
     * @param transparencyConfiguration define the config where to copy the info
     */
    public copyTo(transparencyConfiguration: PBRTransparencyConfiguration): void {
        SerializationHelper.Clone(() => transparencyConfiguration, this);
    }

    /**
     * Serializes this BRDF configuration.
     * @returns - An object with the serialized config.
     */
    public serialize(): any {
        return SerializationHelper.Serialize(this);
    }

    /**
     * Parses a Transparency Configuration from a serialized object.
     * @param source - Serialized object.
     */
    public parse(source: any): void {
        SerializationHelper.Parse(() => this, source, null);
    }
}