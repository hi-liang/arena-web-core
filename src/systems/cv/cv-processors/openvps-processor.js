// src/systems/cv/cv-processors/openvps-processor.js
import { MapServer } from '../../../../static/vendor/openvps/map-server.ts'; // Adjust path
import * as THREE from 'three'; // Explicit THREE import

// Default options for the processor
const DEFAULT_OPTIONS = {
    imageUrl: '',
    interval: 5000, // Milliseconds
    imgQuality: 0.8,
    imgType: 'image/jpeg', // jpeg is generally smaller for network transfer
    flipHorizontal: false,
    flipVertical: false,
    debug: false,
    maxRetries: 3,
    retryDelay: 1000,
    onPoseUpdate: null, // Callback function for pose updates: (newRigMatrix: THREE.Matrix4, serverConfidence: number) => void
    // enabled: true, // Processor is enabled by default, external logic handles permissions
};

export default class OpenVPSProcessor {
    constructor(options = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };

        if (!this.options.imageUrl) {
            console.warn('OpenVPSProcessor: imageUrl is not provided. Processor will be disabled.');
            this.isEnabled = false;
        } else {
            this.isEnabled = true; // Can be set to false externally if permission denied
        }

        try {
            this.mapServer = this.isEnabled ? new MapServer(this.options.imageUrl) : null;
        } catch (error) {
            console.error('OpenVPSProcessor: Failed to initialize MapServer. Processor will be disabled.', error);
            this.isEnabled = false;
            this.mapServer = null;
        }
        
        this.isBusy = false;
        this.lastSendTime = 0;
        this.tempCanvas = null; // Offscreen canvas for image manipulation
        this.retryCount = 0;

        if (this.options.debug) console.log('OpenVPSProcessor initialized with options:', this.options);
    }

    /**
     * Processes image data from CameraImageProvider.
     * Sends an image to OpenVPS server if interval has passed and not busy.
     * @param {CaptureImageData} imageData - Image data from the provider.
     * @param {CaptureMetadata} metadata - Metadata associated with the frame.
     * @returns {Promise<void>}
     */
    async processImage(imageData, metadata) {
        if (!this.isEnabled || !this.mapServer || !imageData || !imageData.buffer) {
            return Promise.resolve();
        }
        // Ensure image data is RGBA as expected by ImageData constructor
        if (imageData.format !== 'RGBA') {
            if (this.options.debug) console.warn(`OpenVPSProcessor: Expected RGBA format, got ${imageData.format}. Skipping.`);
            return Promise.resolve();
        }

        const now = Date.now();
        if (now - this.lastSendTime < this.options.interval || this.isBusy) {
            return Promise.resolve();
        }

        this.isBusy = true;
        this.lastSendTime = now;

        try {
            // 1. Prepare canvas and draw RGBA buffer to it
            if (!this.tempCanvas || this.tempCanvas.width !== imageData.width || this.tempCanvas.height !== imageData.height) {
                this.tempCanvas = document.createElement('canvas');
                this.tempCanvas.width = imageData.width;
                this.tempCanvas.height = imageData.height;
            }
            const ctx = this.tempCanvas.getContext('2d');
            // Ensure buffer is copied, as it might be a shared ArrayBuffer or view that could change
            const imgData = new ImageData(new Uint8ClampedArray(imageData.buffer.slice(0)), imageData.width, imageData.height);
            ctx.putImageData(imgData, 0, 0);

            // 2. Handle flipping if needed (draw to a second canvas for flipping)
            let canvasToBlob = this.tempCanvas;
            if (this.options.flipHorizontal || this.options.flipVertical) {
                const flipCanvas = document.createElement('canvas');
                flipCanvas.width = imageData.width;
                flipCanvas.height = imageData.height;
                const flipCtx = flipCanvas.getContext('2d');
                flipCtx.scale(this.options.flipHorizontal ? -1 : 1, this.options.flipVertical ? -1 : 1);
                flipCtx.drawImage(
                    this.tempCanvas,
                    this.options.flipHorizontal ? -imageData.width : 0,
                    this.options.flipVertical ? -imageData.height : 0
                );
                canvasToBlob = flipCanvas;
            }

            // 3. Convert canvas to Blob
            const blob = await new Promise(resolve => {
                canvasToBlob.toBlob(resolve, this.options.imgType, this.options.imgQuality);
            });

            if (!blob) {
                throw new Error('Failed to convert canvas to Blob.');
            }

            // 4. Get camera's view matrix (inverse of world pose)
            // metadata.viewTransformMatrix is already this.
            const cameraViewMatrix = metadata.viewTransformMatrix; 
            if (!cameraViewMatrix || !(cameraViewMatrix instanceof THREE.Matrix4)) {
                throw new Error('OpenVPSProcessor: Valid cameraViewMatrix (THREE.Matrix4) not found in metadata.');
            }


            if (this.options.debug) {
                console.log(`OpenVPSProcessor: Sending image. Size: ${blob.size / 1024} KB, Timestamp: ${metadata.timestamp}`);
            }

            // 5. Localize with MapServer
            const response = await this.mapServer.localize(blob, 'image'); // 'image' is for content-type: image/*
            
            if (this.options.debug) {
                console.log('OpenVPSProcessor: Received response from server:', response);
            }

            if (response && response.pose && response.serverConfidence > 0) { // Ensure pose exists and confidence is positive
                // response.pose is typically a 3x4 matrix (row-major) or 4x4 (row-major)
                // THREE.Matrix4().fromArray() expects column-major order for a 16-element array.
                // If response.pose is Array<Array<number>> (e.g., [[r11,r12,r13,tx], [r21,r22,r23,ty], [r31,r32,r33,tz], [0,0,0,1]])
                // it needs to be flattened and potentially transposed if it's row-major.
                // Assuming response.pose is already a flat array in column-major order or MapServer handles this.
                // If response.pose is a 2D array (row-major), it needs transpose and flatten.
                // The original openvps.js did `this.transpose(response.pose).flat()`.
                let serverPoseArray = response.pose;
                if (Array.isArray(serverPoseArray) && Array.isArray(serverPoseArray[0])) { // Check if it's a 2D array
                    serverPoseArray = this.transpose(serverPoseArray).flat();
                } else if (!Array.isArray(serverPoseArray) || serverPoseArray.length !== 16) {
                    console.error('OpenVPSProcessor: Invalid pose format from server response.', response.pose);
                    throw new Error('Invalid pose format from server.');
                }


                const localizationPose = new THREE.Matrix4().fromArray(serverPoseArray); // Assumes column-major
                
                const newRigMatrix = new THREE.Matrix4();
                newRigMatrix.multiplyMatrices(localizationPose, cameraViewMatrix);

                if (this.options.onPoseUpdate && typeof this.options.onPoseUpdate === 'function') {
                    this.options.onPoseUpdate(newRigMatrix, response.serverConfidence);
                }
            } else {
                if (this.options.debug) console.log('OpenVPSProcessor: Low confidence or no pose in response.');
            }
            this.retryCount = 0; // Reset retry count on success
        } catch (error) {
            console.error('OpenVPSProcessor: Error during image processing or localization:', error);
            this.retryCount++;
            if (this.retryCount <= this.options.maxRetries) {
                if (this.options.debug) console.log(`OpenVPSProcessor: Retrying in ${this.options.retryDelay}ms... (${this.retryCount}/${this.options.maxRetries})`);
                // Adjust lastSendTime to allow quicker retry, but not immediate to prevent spamming
                this.lastSendTime = Date.now() - this.options.interval + this.options.retryDelay;
            } else {
                if (this.options.debug) console.log('OpenVPSProcessor: Max retries reached.');
                this.lastSendTime = Date.now(); // Prevent further immediate retries after max retries
            }
        } finally {
            this.isBusy = false;
        }
        return Promise.resolve();
    }

    /**
     * Transposes a 2D array (matrix).
     * @param {Array<Array<number>>} matrix The matrix to transpose.
     * @returns {Array<Array<number>>} The transposed matrix.
     */
    transpose(matrix) {
        if (!matrix || !matrix.length || !matrix[0] || !matrix[0].map) {
            console.error('OpenVPSProcessor: Invalid matrix for transpose:', matrix);
            return matrix; // Return original if invalid
        }
        try {
            // Handles 3x4 or 4x4 matrices
            const rows = matrix.length;
            const cols = matrix[0].length;
            const transposed = [];
            for (let j = 0; j < cols; j++) {
                transposed[j] = Array(rows);
            }
            for (let i = 0; i < rows; i++) {
                for (let j = 0; j < cols; j++) {
                    transposed[j][i] = matrix[i][j];
                }
            }
            return transposed;
        } catch (e) {
            console.error('OpenVPSProcessor: Error during transpose:', e, matrix);
            return matrix; // Return original on error
        }
    }

    setEnabled(enabled) {
        this.isEnabled = !!enabled;
        if (this.options.debug) console.log(`OpenVPSProcessor: Enabled state set to ${this.isEnabled}`);
    }

    destroy() {
        if (this.options.debug) console.log('OpenVPSProcessor destroyed.');
        this.isEnabled = false;
        this.mapServer = null; // Allow garbage collection
        this.tempCanvas = null;
        // TODO: Cancel any ongoing fetch request if MapServer supports it
        // (MapServer uses fetch internally, may need an AbortController)
    }

    isAsync() {
        return false; // The main processing logic posts an async request but doesn't block the pipeline.
    }
}
