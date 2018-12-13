
declare module BABYLON {
    /**
     * Holds a collection of exporter options and parameters
     */
    interface IExportOptions {
        /**
         * Function which indicates whether a babylon mesh should be exported or not
         * @param transformNode source Babylon transform node. It is used to check whether it should be exported to glTF or not
         * @returns boolean, which indicates whether the mesh should be exported (true) or not (false)
         */
        shouldExportTransformNode?(transformNode: TransformNode): boolean;
        /**
         * The sample rate to bake animation curves
         */
        animationSampleRate?: number;
        /**
         * Begin serialization without waiting for the scene to be ready
         */
        exportWithoutWaitingForScene?: boolean;
    }
    /**
     * Class for generating glTF data from a Babylon scene.
     */
    class GLTF2Export {
        /**
         * Exports the geometry of the scene to .gltf file format asynchronously
         * @param scene Babylon scene with scene hierarchy information
         * @param filePrefix File prefix to use when generating the glTF file
         * @param options Exporter options
         * @returns Returns an object with a .gltf file and associates texture names
         * as keys and their data and paths as values
         */
        static GLTFAsync(scene: Scene, filePrefix: string, options?: IExportOptions): Promise<GLTFData>;
        private static _PreExportAsync;
        private static _PostExportAsync;
        /**
         * Exports the geometry of the scene to .glb file format asychronously
         * @param scene Babylon scene with scene hierarchy information
         * @param filePrefix File prefix to use when generating glb file
         * @param options Exporter options
         * @returns Returns an object with a .glb filename as key and data as value
         */
        static GLBAsync(scene: Scene, filePrefix: string, options?: IExportOptions): Promise<GLTFData>;
    }
}

declare module BABYLON {
    /**
     * Class for holding and downloading glTF file data
     */
    class GLTFData {
        /**
         * Object which contains the file name as the key and its data as the value
         */
        glTFFiles: {
            [fileName: string]: string | Blob;
        };
        /**
         * Initializes the glTF file object
         */
        constructor();
        /**
         * Downloads the glTF data as files based on their names and data
         */
        downloadFiles(): void;
    }
}

declare module BABYLON {
    /**
     * Interface for extending the exporter
     * @hidden
     */
    interface IGLTFExporterExtension {
        /**
         * The name of this extension
         */
        readonly name: string;
        /**
         * Defines whether this extension is enabled
         */
        enabled: boolean;
        /**
         * Defines whether this extension is required
         */
        required: boolean;
    }
}
