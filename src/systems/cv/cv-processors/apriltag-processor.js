// src/systems/cv/cv-processors/apriltag-processor.js
import CVWorkerMsgs from '../../armarker/worker-msgs.js'; // Adjust path if needed
import ARMarkerRelocalization from '../../armarker/armarker-reloc.js'; // Adjust path
// import { ARENAUtils } from '../../../utils'; // If needed

// Make sure this path correctly resolves to dist/apriltag.js from the final execution context.
// It might need to be an absolute path or configured during build.
// For development, this relative path assumes a certain structure.
const APRILTĀG_WORKER_URL = new URL('../../../../dist/apriltag.js', import.meta.url);

export default class AprilTagProcessor {
    constructor(options = {}) {
        this.options = {
            debug: false,
            enableRelocalization: false, // Default to false, to be explicitly enabled
            // Expected options if enableRelocalization is true:
            // arenaScene: AFRAME.scenes[0], (needed by ARMarkerRelocalization)
            // arMarkerSystemInterface: { getMarker: (id) => { ... } } (for ARMarkerRelocalization)
            // networkedLocationSolver: false (for ARMarkerRelocalization)
            // debugRelocalization: false, (for ARMarkerRelocalization's own debug)
            // cameraRigId: 'cameraRig', // Default used by ARMarkerRelocalization
            // cameraSpinnerId: 'cameraSpinner', // Default used by ARMarkerRelocalization
            ...options,
        };

        this.cvWorkerReady = false; // Flag to track worker initialization
        this.cvWorker = new Worker(APRILTĀG_WORKER_URL, { type: 'module' });
        this.cvWorker.addEventListener('message', this._handleCvWorkerMessage.bind(this));
        this.cvWorker.postMessage({ type: CVWorkerMsgs.type.INIT }); // Initialize worker

        this.detectionEvents = new EventTarget();
        this.grayscaleBuffer = null;
        this.knownMarkers = new Map(); // Store known marker sizes (markerId -> sizeInMeters)

        if (this.options.enableRelocalization) {
            if (!this.options.arenaScene || !this.options.arMarkerSystemInterface) {
                console.warn('AprilTagProcessor: Relocalization enabled, but arenaScene or arMarkerSystemInterface not provided in options. Relocalization will be disabled.');
                this.options.enableRelocalization = false;
            } else {
                const relocDeps = {
                    arMakerSys: this.options.arMarkerSystemInterface,
                    detectionsEventTarget: this.detectionEvents,
                    networkedLocationSolver: !!this.options.networkedLocationSolver,
                    debug: !!this.options.debugRelocalization, 
                };
                try {
                    this.relocalizer = new ARMarkerRelocalization(relocDeps);
                     if (this.options.debug) console.log('AprilTagProcessor: ARMarkerRelocalization initialized.');
                } catch (error) {
                    console.error('AprilTagProcessor: Error initializing ARMarkerRelocalization:', error);
                    this.options.enableRelocalization = false; 
                }
            }
        }
        if (this.options.debug) console.log(`AprilTagProcessor initialized. Relocalization enabled: ${this.options.enableRelocalization}`);
    }
    
    _softwareGrayscale(buffer, width, height) {
        if (this.options.debug) console.log('AprilTagProcessor: Used software grayscaling.');
        // Ensure grayscaleBuffer is correctly sized (already done outside by caller)
        // L = 0.299*R + 0.587*G + 0.114*B
        for (let i = 0, j = 0; i < buffer.length; i += 4, j++) {
            this.grayscaleBuffer[j] = 0.299 * buffer[i] + 0.587 * buffer[i + 1] + 0.114 * buffer[i + 2];
        }
    }

    async processImage(imageData, metadata) {
        if (!this.cvWorkerReady) {
            if (this.options.debug) console.warn('AprilTagProcessor: Worker not ready, skipping frame.');
            return Promise.resolve();
        }

        if (!imageData || !(imageData.buffer || imageData.canvas)) { // Check for buffer OR canvas
            if (this.options.debug) console.warn('AprilTagProcessor: No image data buffer or canvas received.');
            return Promise.resolve();
        }
        
        if (!metadata.cameraIntrinsics) {
            if (this.options.debug) console.warn('AprilTagProcessor: Camera intrinsics not available in metadata. Skipping frame.');
            return Promise.resolve();
        }

        const { width, height } = imageData;

        if (!this.grayscaleBuffer || this.grayscaleBuffer.length !== width * height) {
            this.grayscaleBuffer = new Uint8Array(width * height);
        }

        if (imageData.canvas && imageData.format === 'RGBA') {
            try {
                const ctx = imageData.canvas.getContext('2d', { willReadFrequently: true }); 
                // The canvas from GetUserMediaCaptureHelper should be up-to-date.
                
                // Apply grayscale filter using CSS filter and drawImage
                // This is a common trick, but browser support for filter on 2D context varies.
                // A more robust way might be to read pixels and do it manually if this fails often.
                // For now, assuming this works in target environments or fallback is acceptable.
                ctx.filter = 'grayscale(100%)';
                ctx.drawImage(imageData.canvas, 0, 0, width, height);
                ctx.filter = 'none'; // Reset filter IMPORTANT

                const filteredImageData = ctx.getImageData(0, 0, width, height).data;
                for (let i = 0, j = 0; i < filteredImageData.length; i += 4, j++) {
                    this.grayscaleBuffer[j] = filteredImageData[i]; // R channel (R=G=B in grayscale)
                }
                if (this.options.debug) console.log('AprilTagProcessor: Used canvas grayscaling.');
            } catch (e) {
                if (this.options.debug) console.warn('AprilTagProcessor: Canvas grayscaling failed, falling back to software.', e);
                if (!imageData.buffer) { // Check if buffer is available for fallback
                    if (this.options.debug) console.error('AprilTagProcessor: No buffer available for software grayscale fallback.');
                    return Promise.resolve();
                }
                this._softwareGrayscale(imageData.buffer, width, height);
            }
        } else if (imageData.buffer && imageData.format === 'RGBA') {
            // Fallback to software if no canvas or not RGBA (though canvas path also checks RGBA)
            this._softwareGrayscale(imageData.buffer, width, height);
        } else {
            if (this.options.debug) console.warn(`AprilTagProcessor: Expected RGBA format with buffer, or RGBA with canvas. Got format ${imageData.format}. Skipping.`);
            return Promise.resolve();
        }


        const workerMessage = {
            type: CVWorkerMsgs.type.PROCESS_GSFRAME,
            grayscalePixels: this.grayscaleBuffer,
            width,
            height,
            cameraIntrinsics: metadata.cameraIntrinsics, 
            frameTimestamp: metadata.timestamp,
        };
        
        this.cvWorker.postMessage(workerMessage, [workerMessage.grayscalePixels.buffer]);
        this.grayscaleBuffer = null; 

        return Promise.resolve(); 
    }

    _handleCvWorkerMessage(event) {
        const { type, detections, ts, grayscalePixels, error } = event.data;

        if (grayscalePixels) {
            this.grayscaleBuffer = new Uint8Array(grayscalePixels);
        }

        switch (type) {
            case CVWorkerMsgs.type.FRAME_RESULTS:
                if (detections && detections.length > 0 && this.options.debug) {
                    console.log(`AprilTagProcessor: Detections received (count: ${detections.length}) for timestamp: ${ts}`);
                }
                this.detectionEvents.dispatchEvent(
                    new CustomEvent('armarker-detection', {
                        detail: { detections: detections || [], ts }, 
                    })
                );
                break;
            case CVWorkerMsgs.type.INIT_DONE:
                this.cvWorkerReady = true;
                if (this.options.debug) console.log('AprilTagProcessor: CV Worker initialized (INIT_DONE).');
                this.knownMarkers.forEach((size, id) => this._sendMarkerToWorker(id, size));
                break;
            case CVWorkerMsgs.type.ERROR:
                console.error('AprilTagProcessor: Error from CV Worker:', error ? error.message : 'Unknown error', event.data);
                break;
            default:
                if (this.options.debug) console.log('AprilTagProcessor: Received unhandled message from CV Worker:', event.data);
        }
    }

    _sendMarkerToWorker(markerId, sizeInMeters) {
        if (!this.cvWorker || !this.cvWorkerReady) {
            if (this.options.debug && !this.cvWorkerReady) console.warn(`AprilTagProcessor: Worker not ready, cannot send marker ${markerId}. It will be sent on INIT_DONE.`);
            return;
        }
        this.cvWorker.postMessage({
            type: CVWorkerMsgs.type.KNOWN_MARKER_ADD,
            markerid: markerId, 
            size: sizeInMeters,
        });
         if (this.options.debug) console.log(`AprilTagProcessor: Sent marker ${markerId} (size: ${sizeInMeters}m) to worker.`);
    }

    addKnownMarker(markerId, sizeInMillimeters) {
        const markerIdStr = String(markerId);
        const sizeInMeters = parseFloat(sizeInMillimeters) / 1000.0;

        if (isNaN(sizeInMeters) || sizeInMeters <= 0) {
            console.error(`AprilTagProcessor: Invalid size for marker ${markerIdStr}: ${sizeInMillimeters}mm. Must be positive.`);
            return;
        }

        this.knownMarkers.set(markerIdStr, sizeInMeters);
        if (this.cvWorkerReady) {
             this._sendMarkerToWorker(markerIdStr, sizeInMeters);
        } else if (this.options.debug) {
            console.log(`AprilTagProcessor: Worker not ready. Marker ${markerIdStr} will be sent upon worker initialization.`);
        }
    }

    removeKnownMarker(markerId) {
        const markerIdStr = String(markerId);
        this.knownMarkers.delete(markerIdStr);
        if (this.cvWorkerReady) { 
            this.cvWorker.postMessage({
                type: CVWorkerMsgs.type.KNOWN_MARKER_DEL,
                markerid: markerIdStr,
            });
            if (this.options.debug) console.log(`AprilTagProcessor: Sent remove request for marker ${markerIdStr} to worker.`);
        }
    }

    destroy() {
        if (this.cvWorker) {
            this.cvWorker.terminate();
            this.cvWorker = null;
            this.cvWorkerReady = false;
        }
        if (this.relocalizer && typeof this.relocalizer.destroy === 'function') {
            // this.relocalizer.destroy();
            if (this.options.debug) console.log('AprilTagProcessor: ARMarkerRelocalization "destroy" called (if exists).');
        }
        this.grayscaleBuffer = null;
        this.knownMarkers.clear();
        if (this.options.debug) console.log('AprilTagProcessor destroyed.');
    }

    isAsync() {
        return false;
    }
}
