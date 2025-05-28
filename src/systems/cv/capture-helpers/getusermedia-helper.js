// Investigation of src/systems/armarker/camera-capture/ccarheadset.js:
// - Raw image format: HTMLVideoElement sourced from `navigator.mediaDevices.getUserMedia()`.
// - Processing:
//   - Video element is drawn to a 2D canvas (`this.canvasCtx.drawImage(this.video, ...)`).
//   - `getImageData()` is called on the canvas context to get pixel data.
//   - Grayscale conversion: `(R+G+B)/3` for each pixel. Result stored in `this.frameGsPixels`.
// - Data to CV Worker: Message with { type: CVWorkerMsgs.type.PROCESS_GSFRAME, ts, width, height, grayscalePixels, camera }.
//   - `grayscalePixels` is the Uint8ClampedArray containing the derived grayscale image.
//   - `camera` contains intrinsics. `ccarheadset.js` has two methods for this:
//     - `getCameraIntrinsics()`: Uses a hardcoded projection matrix based on headset type (`this.arHeadset`).
//     - `getCameraIntrinsics2()`: Uses a hardcoded FOV (64.69 deg) and aspect ratio to calculate fx, fy. cx, cy are center. This seems to be the one actually used for HoloLens 2 (`hl2`).

// Investigation of src/systems/armarker/camera-capture/ccwebar.js:
// - Raw image format: Also an HTMLVideoElement from `navigator.mediaDevices.getUserMedia()`, managed by `GetUserMediaARSource`.
// - Processing:
//   - Similar to `ccarheadset.js`: video drawn to canvas, `getImageData()`, then grayscale conversion `(R+G+B)/3`.
//   - Handles screen resizing and orientation changes via `onResize()`.
// - Data to CV Worker: Message with { type: CVWorkerMsgs.type.PROCESS_GSFRAME, ts, width, height, grayscalePixels, camera }.
//   - `camera` intrinsics are calculated with fx = fy = frameWidth (landscape) or frameHeight (portrait), and cx, cy as center. This is a simpler model.

import BaseCaptureHelper from './base-capture-helper.js';
const THREE = AFRAME.THREE; // Access THREE.js via AFRAME

export default class GetUserMediaCaptureHelper extends BaseCaptureHelper {
    constructor(aframeCameraEl = null, options = {}) {
        super(null, null, aframeCameraEl, options);

        this.aframeCameraEl = aframeCameraEl; 

        const defaultOptions = {
            debug: false,
            isHeadset: false, 
            requestedWidth: 640,
            requestedHeight: 480,
            videoConstraints: null, 
        };
        this.options = { ...defaultOptions, ...options }; 

        this.videoStream = null;
        this.videoElement = null;
        this.canvasElement = null;
        this.canvasContext = null;
        this.framePixels = null; 
        this.frameWidth = 0;
        this.frameHeight = 0;
        this.currentFacingMode = null; 

        // Reusable THREE.Matrix4 instances
        this.reusableWorldPose = new THREE.Matrix4();
        this.reusableViewTransformMatrix = new THREE.Matrix4();
        // Note: projectionMatrix is handled as Float32Array, so no reusable THREE.Matrix4 for it here.

        if (this.options.debug) {
            console.log('GetUserMediaCaptureHelper: Constructor options:', this.options);
        }
    }

    static isSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    async init() {
        if (this.isCapturing) { 
            if (this.options.debug) console.log('GetUserMediaCaptureHelper: Already initialized (isCapturing=true), init skipped.');
            if(this.videoElement) return true;
        }

        if (!GetUserMediaCaptureHelper.isSupported()) {
            console.error('GetUserMediaCaptureHelper: getUserMedia API not supported.');
            return false;
        }
        if (!this.aframeCameraEl && this.options.debug) { 
            console.warn('GetUserMediaCaptureHelper: A-Frame camera element (aframeCameraEl) not provided. Pose information may be limited.');
        }

        this.videoElement = document.createElement('video');
        this.videoElement.setAttribute('autoplay', '');
        this.videoElement.setAttribute('playsinline', ''); 
        this.videoElement.setAttribute('muted', ''); 
        this.videoElement.style.display = 'none'; 

        let videoConstraints;
        if (this.options.videoConstraints) {
            videoConstraints = this.options.videoConstraints;
            if (typeof videoConstraints.facingMode === 'string') {
                this.currentFacingMode = videoConstraints.facingMode;
            } else if (typeof videoConstraints.facingMode?.exact === 'string') {
                this.currentFacingMode = videoConstraints.facingMode.exact;
            } else if (typeof videoConstraints.facingMode?.ideal === 'string') {
                this.currentFacingMode = videoConstraints.facingMode.ideal;
            }
        } else {
            this.currentFacingMode = this.options.isHeadset ? 'user' : 'environment';
            videoConstraints = {
                width: { ideal: this.options.requestedWidth },
                height: { ideal: this.options.requestedHeight },
                facingMode: this.currentFacingMode,
            };
        }

        if (this.options.debug) {
            console.log('GetUserMediaCaptureHelper: Using video constraints:', videoConstraints);
        }

        try {
            document.body.appendChild(this.videoElement); 
            this.videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
            this.videoElement.srcObject = this.videoStream;

            await new Promise((resolve, reject) => {
                this.videoElement.onplaying = () => {
                    if (this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0) {
                        resolve();
                    } else {
                        this.videoElement.onloadedmetadata = () => { 
                            if (this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0) {
                                resolve();
                            } else {
                                reject(new Error('Video dimensions not available after play/loadedmetadata.'));
                            }
                        };
                    }
                };
                this.videoElement.onerror = (e) => reject(new Error(`Video element error: ${e.message || 'Unknown error'}`));
            });
            
            this.frameWidth = this.videoElement.videoWidth;
            this.frameHeight = this.videoElement.videoHeight;

            if (this.frameWidth === 0 || this.frameHeight === 0) {
                throw new Error('Video dimensions are zero after play.');
            }

            this.canvasElement = document.createElement('canvas');
            this.canvasElement.width = this.frameWidth;
            this.canvasElement.height = this.frameHeight;
            this.canvasContext = this.canvasElement.getContext('2d', { willReadFrequently: true });
            this.framePixels = new Uint8ClampedArray(this.frameWidth * this.frameHeight * 4);
            this.isCapturing = true; 

            if (this.options.debug) {
                console.log(`GetUserMediaCaptureHelper: Init successful. Stream dimensions: ${this.frameWidth}x${this.frameHeight}`);
            }
            return true;
        } catch (error) {
            console.error('GetUserMediaCaptureHelper: Error during init:', error.name, error.message);
            if (this.options.debug) console.error(error);
            this.destroy(); 
            return false;
        }
    }

    async getFrameData(time) { 
        if (!this.isCapturing || !super.isStreaming || !this.videoElement ||
            this.videoElement.readyState < this.videoElement.HAVE_METADATA || 
            this.videoElement.paused || this.videoElement.ended) {
            return null;
        }

        if (!this.aframeCameraEl || !this.aframeCameraEl.object3D) {
             if (this.options.debug) console.warn('GetUserMediaCaptureHelper: aframeCameraEl not available for pose data.');
        }

        try {
            this.canvasContext.drawImage(this.videoElement, 0, 0, this.frameWidth, this.frameHeight);
            const imageDataFromCanvas = this.canvasContext.getImageData(0, 0, this.frameWidth, this.frameHeight);
            this.framePixels.set(imageDataFromCanvas.data);
        } catch (error) {
            console.error('GetUserMediaCaptureHelper: Error drawing or getting image data:', error);
            return null;
        }

        // Use reusable matrices
        const aframeCameraProjectionMatrixElements = new Float32Array(16); // For projection matrix

        if (this.aframeCameraEl && this.aframeCameraEl.object3D && this.aframeCameraEl.object3D.matrixWorld) {
            this.reusableWorldPose.copy(this.aframeCameraEl.object3D.matrixWorld);
            if (this.aframeCameraEl.components.camera) { 
                 this.aframeCameraEl.components.camera.updateProjectionMatrix(); 
                 // Copy elements to Float32Array, as projectionMatrix in metadata is defined as such
                 aframeCameraProjectionMatrixElements.set(this.aframeCameraEl.components.camera.projectionMatrix.elements);
            } else {
                if(this.options.debug) console.warn('GetUserMediaCaptureHelper: A-Frame camera component not found on aframeCameraEl.');
                 new THREE.Matrix4().identity().toArray(aframeCameraProjectionMatrixElements); // Identity if no camera component
            }
            this.reusableViewTransformMatrix.copy(this.reusableWorldPose).invert();
        } else {
             if (this.options.debug) console.warn('GetUserMediaCaptureHelper: aframeCameraEl.object3D not available for matrix data.');
             this.reusableWorldPose.identity();
             this.reusableViewTransformMatrix.identity();
             new THREE.Matrix4().identity().toArray(aframeCameraProjectionMatrixElements); // Identity projection
        }

        const cameraIntrinsics = null; 

        return {
            imageData: {
                buffer: this.framePixels, 
                width: this.frameWidth,
                height: this.frameHeight,
                format: 'RGBA',
                originalFormat: 'HTMLVideoElement',
                canvas: this.canvasElement 
            },
            metadata: {
                timestamp: time,
                worldPose: this.reusableWorldPose, 
                cameraIntrinsics, 
                projectionMatrix: aframeCameraProjectionMatrixElements, 
                viewTransformMatrix: this.reusableViewTransformMatrix, 
                facingMode: this.currentFacingMode,
            },
        };
    }

    startStreaming() { 
        super.startStreaming(); 
        if (this.videoElement && this.videoElement.paused) {
            this.videoElement.play().catch(error => {
                console.error('GetUserMediaCaptureHelper: Error trying to play video in startStreaming:', error);
            });
        }
        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Streaming started.');
    }

    stopStreaming() { 
        super.stopStreaming(); 
        if (this.videoElement && !this.videoElement.paused) {
            this.videoElement.pause();
        }
        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Streaming stopped (video paused).');
    }

    destroy() {
        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Destroying...');
        super.stopStreaming(); 

        if (this.videoStream) { 
            this.videoStream.getTracks().forEach(track => track.stop());
            this.videoStream = null;
        }

        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.srcObject = null;
            if (this.videoElement.parentNode) {
                this.videoElement.parentNode.removeChild(this.videoElement);
            }
        }
        this.videoElement = null;
        
        this.canvasElement = null;
        this.canvasContext = null;
        this.framePixels = null;
        super.destroy(); 

        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Destroyed.');
    }
}

GetUserMediaCaptureHelper.prototype.usesXRFrame = false;
// GetUserMediaCaptureHelper.isSupported = GetUserMediaCaptureHelper.isSupported; // Not needed static inherited.
