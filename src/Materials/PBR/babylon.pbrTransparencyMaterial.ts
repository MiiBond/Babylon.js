module BABYLON {
    /**
     * The PBR material of BJS following the metal roughness convention.
     *
     * This fits to the PBR convention in the GLTF definition:
     * https://github.com/KhronosGroup/glTF/tree/2.0/specification/2.0
     */
    export class PBRTransparencyMaterial extends PBRMaterial {

        /**
         * The base color has two different interhttp://localhost:1338/Playground/index-local.htmlpretations depending on the value of metalness.
         * When the material is a metal, the base color is the specific measured reflectance value
         * at normal incidence (F0). For a non-metal the base color represents the reflected diffuse color
         * of the material.
         */
        @serializeAsColor3()
        @expandToProperty("_markAllSubMeshesAsTexturesDirty", "_interiorColor")
        public interiorColor: Color3;

        /**
         * Stuff
         */
        @serialize()
        @expandToProperty("_markAllSubMeshesAsTexturesDirty", "_interiorDensity")
        public interiorDensity: number;

        /**
         * Stuff
         */
        @serializeAsTexture()
        @expandToProperty("_markAllSubMeshesAsTexturesDirty", "_transmissionTexture")
        public transmissionTexture: BaseTexture;

        /**
         * Stuff
         */
        @serialize()
        @expandToProperty("_markAllSubMeshesAsTexturesDirty", "_opticalTransmission")
        public opticalTransmission: number;

        /**
         * Stuff
         */
        @serializeAsTexture()
        @expandToProperty("_markAllSubMeshesAsTexturesDirty", "_sceneTexture")
        public sceneTexture: RenderTargetTexture;

        /**
         * Instantiates a new PBRMetalRoughnessMaterial instance.
         *
         * @param name The material name
         * @param scene The scene the material will be use in.
         */
        constructor(name: string, scene: Scene) {
            super(name, scene);
        }

        /**
         * Return the currrent class name of the material.
         */
        public getClassName(): string {
            return "PBRTransparencyMaterial";
        }

        public useAdobeTransparency(): boolean {
            return true;
        }

        /**
         * Return the active textures of the material.
         */
        public getActiveTextures(): BaseTexture[] {
            var activeTextures = super.getActiveTextures();

            if (this.sceneTexture) {
                activeTextures.push(this.sceneTexture);
            }

            if (this.transmissionTexture) {
                activeTextures.push(this.transmissionTexture);
            }

            return activeTextures;
        }

        /**
         * Checks to see if a texture is used in the material.
         * @param texture - Base texture to use.
         * @returns - Boolean specifying if a texture is used in the material.
         */
        public hasTexture(texture: BaseTexture): boolean {
            if (super.hasTexture(texture)) {
                return true;
            }

            if (this.sceneTexture === texture) {
                return true;
            }

            if (this.transmissionTexture === texture) {
                return true;
            }

            return false;
        }

        /**
         * Makes a duplicate of the current material.
         * @param name - name to use for the new material.
         */
        public clone(name: string): PBRTransparencyMaterial {
            var clone = SerializationHelper.Clone(() => new PBRTransparencyMaterial(name, this.getScene()), this);

            clone.id = name;
            clone.name = name;

            return clone;
        }

        /**
         * Serialize the material to a parsable JSON object.
         */
        public serialize(): any {
            var serializationObject = SerializationHelper.Serialize(this);
            serializationObject.customType = "BABYLON.PBRTransparencyMaterial";
            return serializationObject;
        }

        /**
         * Parses a JSON object correponding to the serialize function.
         */
        public static Parse(source: any, scene: Scene, rootUrl: string): PBRTransparencyMaterial {
            return SerializationHelper.Parse(() => new PBRTransparencyMaterial(source.name, scene), source, scene, rootUrl);
        }
    }
}