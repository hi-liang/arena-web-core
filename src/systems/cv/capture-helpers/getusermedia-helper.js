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
    constructor(aframeCameraEl = null, options = {}, providerInterface = null) {
        super(null, null, aframeCameraEl, options);

        this.aframeCameraEl = aframeCameraEl; 
        this.providerInterface = providerInterface; // Store the provider interface

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
        this.videoFrameCallbackHandle = null; // To track if rVFC loop is active

        // Reusable THREE.Matrix4 instances
        this.reusableWorldPose = new THREE.Matrix4();
        this.reusableViewTransformMatrix = new THREE.Matrix4();
        this.reusableProjectionMatrix = new THREE.Matrix4(); // For copying projection matrix

        this._onVideoFrame = this._onVideoFrame.bind(this); // Bind the new callback method

        if (this.options.debug) {
            console.log('GetUserMediaCaptureHelper: Constructor options:', this.options);
        }
    }

    static isSupported() {
        // Also check for requestVideoFrameCallback support
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && 
                  HTMLVideoElement && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function');
    }

    async init() {
        if (this.isCapturing) { 
            if (this.options.debug) console.log('GetUserMediaCaptureHelper: Already initialized (isCapturing=true), init skipped.');
            if(this.videoElement) return true;
        }

        if (!GetUserMediaCaptureHelper.isSupported()) {
            console.error('GetUserMediaCaptureHelper: getUserMedia API or requestVideoFrameCallback not supported.');
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
            this.isCapturing = true; // Mark as initialized and ready

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

    async _onVideoFrame(now, videoFrameMetadata) {
        // isStreaming is used from BaseCaptureHelper to control the loop
        if (!this.isCapturing || !super.isStreaming || !this.videoElement || 
            this.videoElement.readyState < this.videoElement.HAVE_METADATA || 
            this.videoElement.paused || this.videoElement.ended) {
            
            // If still supposed to be capturing and streaming, but video ended/paused unexpectedly, try to restart rVFC
            // However, if !super.isStreaming, it means stopStreaming() was called, so we should not request another frame.
            if (this.isCapturing && super.isStreaming && this.videoElement && 
                typeof this.videoElement.requestVideoFrameCallback === 'function') {
                try {
                    this.videoElement.requestVideoFrameCallback(this._onVideoFrame);
                } catch (e) {
                    console.error("GetUserMediaCaptureHelper: Error requesting video frame callback in _onVideoFrame check:", e);
                }
            }
            return;
        }

        try {
            this.canvasContext.drawImage(this.videoElement, 0, 0, this.frameWidth, this.frameHeight);
            const imageDataFromCanvas = this.canvasContext.getImageData(0, 0, this.frameWidth, this.frameHeight);
            
            if (this.framePixels && this.framePixels.length === imageDataFromCanvas.data.length) {
                this.framePixels.set(imageDataFromCanvas.data);
            } else {
                this.framePixels = new Uint8ClampedArray(imageDataFromCanvas.data); // Re-initialize if needed
            }
        } catch (error) {
            console.error('GetUserMediaCaptureHelper: Error drawing or getting image data:', error);
            // Request next frame even on error to keep the loop attempting
            if (this.isCapturing && super.isStreaming && this.videoElement && typeof this.videoElement.requestVideoFrameCallback === 'function') {
                 try { this.videoElement.requestVideoFrameCallback(this._onVideoFrame); } catch(e) { /* ignore */ }
            }
            return;
        }

        const timestamp = videoFrameMetadata.captureTime || videoFrameMetadata.presentedFrames || now; // Use presentedFrames as a fallback for mediaTime

        const aframeCameraProjectionMatrixElements = new Float32Array(16); 

        if (this.aframeCameraEl && this.aframeCameraEl.object3D) {
            this.reusableWorldPose.copy(this.aframeCameraEl.object3D.matrixWorld);
            if (this.aframeCameraEl.components.camera) { 
                 this.aframeCameraEl.components.camera.updateProjectionMatrix(); 
                 aframeCameraProjectionMatrixElements.set(this.aframeCameraEl.components.camera.projectionMatrix.elements);
            } else {
                if(this.options.debug) console.warn('GetUserMediaCaptureHelper: A-Frame camera component not found on aframeCameraEl.');
                 this.reusableProjectionMatrix.identity().toArray(aframeCameraProjectionMatrixElements);
            }
            this.reusableViewTransformMatrix.copy(this.reusableWorldPose).invert();
        } else {
             if (this.options.debug) console.warn('GetUserMediaCaptureHelper: aframeCameraEl.object3D not available for matrix data.');
             this.reusableWorldPose.identity();
             this.reusableProjectionMatrix.identity().toArray(aframeCameraProjectionMatrixElements);
             this.reusableViewTransformMatrix.identity();
        }

        const cameraIntrinsics = null; 

        const frameData = {
            imageData: {
                buffer: this.framePixels, 
                width: this.frameWidth,
                height: this.frameHeight,
                format: 'RGBA',
                originalFormat: 'HTMLVideoElement',
                canvas: this.canvasElement 
            },
            metadata: {
                timestamp: timestamp,
                worldPose: this.reusableWorldPose, 
                cameraIntrinsics, 
                projectionMatrix: aframeCameraProjectionMatrixElements, 
                viewTransformMatrix: this.reusableViewTransformMatrix, 
                facingMode: this.currentFacingMode,
            },
        };

        if (this.providerInterface && typeof this.providerInterface.distributeFrameData === 'function') {
            this.providerInterface.distributeFrameData(frameData);
        } else if (this.options.debug) { // Only log warning if debug is enabled
            console.warn('GetUserMediaCaptureHelper: providerInterface.distributeFrameData is not available.');
        }

        if (this.isCapturing && super.isStreaming && this.videoElement && typeof this.videoElement.requestVideoFrameCallback === 'function') {
            try {
                this.videoElement.requestVideoFrameCallback(this._onVideoFrame);
            } catch (e) {
                console.error("GetUserMediaCaptureHelper: Error requesting video frame callback at end of _onVideoFrame:", e);
            }
        }
    }

    startStreaming() { 
        super.startStreaming(); // Sets this.isStreaming = true
        if (this.isCapturing && this.videoElement && typeof this.videoElement.requestVideoFrameCallback === 'function') {
            if (this.videoElement.paused) { // Ensure video is playing
                this.videoElement.play().then(() => {
                    // Start rVFC loop only after play promise resolves
                    if (!this.videoFrameCallbackHandle) { // Check if loop isn't already considered active
                         try {
                            this.videoElement.requestVideoFrameCallback(this._onVideoFrame);
                            this.videoFrameCallbackHandle = true; // Indicate loop has been started
                            if (this.options.debug) console.log('GetUserMediaCaptureHelper: Started requestVideoFrameCallback loop after play.');
                         } catch(e) {
                            console.error("GetUserMediaCaptureHelper: Error starting requestVideoFrameCallback loop after play:", e);
                         }
                    }
                }).catch(error => {
                    console.error('GetUserMediaCaptureHelper: Error trying to play video in startStreaming:', error);
                });
            } else if (!this.videoFrameCallbackHandle) { // Video is already playing
                 try {
                    this.videoElement.requestVideoFrameCallback(this._onVideoFrame);
                    this.videoFrameCallbackHandle = true; // Indicate loop has been started
                    if (this.options.debug) console.log('GetUserMediaCaptureHelper: Started requestVideoFrameCallback loop.');
                 } catch(e) {
                    console.error("GetUserMediaCaptureHelper: Error starting requestVideoFrameCallback loop:", e);
                 }
            }
        } else if (this.options.debug) {
            console.warn('GetUserMediaCaptureHelper: Could not start rVFC loop. Conditions not met:', 
                         `isCapturing=${this.isCapturing}`, 
                         `videoElement=${!!this.videoElement}`,
                         `rVFC supported=${typeof this.videoElement?.requestVideoFrameCallback === 'function'}`);
        }
    }

    stopStreaming() { 
        super.stopStreaming(); // Sets this.isStreaming = false
        // The isStreaming flag will cause _onVideoFrame to stop queueing new callbacks.
        // No specific handle to cancel rVFC, the loop self-terminates based on isStreaming.
        this.videoFrameCallbackHandle = false; // Reset the flag indicating loop is active

        if (this.videoElement && !this.videoElement.paused) {
            this.videoElement.pause();
        }
        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Stopped requestVideoFrameCallback loop (video paused).');
    }

    // Old getFrameData is removed.

    destroy() {
        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Destroying...');
        // isCapturing is set to false by super.destroy()
        // isStreaming is set to false by super.stopStreaming() which is called by super.destroy()

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
        this.videoFrameCallbackHandle = false; // Ensure flag is reset
        
        this.canvasElement = null;
        this.canvasContext = null;
        this.framePixels = null;
        super.destroy(); 

        if (this.options.debug) console.log('GetUserMediaCaptureHelper: Destroyed.');
    }
}

GetUserMediaCaptureHelper.prototype.usesXRFrame = false;
// GetUserMediaCaptureHelper.isSupported = GetUserMediaCaptureHelper.isSupported; // Static methods are inherited.
