import WebXRRawCameraCaptureHelper from './capture-helpers/webxr-raw-camera-helper.js';
import WebARViewerCaptureHelper from './capture-helpers/webar-viewer-helper.js';
import GetUserMediaCaptureHelper from './capture-helpers/getusermedia-helper.js';
import { ARENAUtils } from '../../utils';

/**
 * Provides camera images synchronized with the WebXR frame loop (or window rAF for GUM)
 * to registered CV Processors. Handles different camera access APIs
 * via dedicated Capture Helper classes.
 */
export default class CameraImageProvider {
    /**
     * @param {XRSession} xrSession The active WebXR session (can be null if API doesn't require it initially).
     * @param {WebGLRenderingContext} glContext The WebGL rendering context.
     * @param {XRReferenceSpace} xrRefSpace The XR reference space (can be null initially).
     * @param {AFRAME.Entity} aframeCameraEl The A-Frame camera entity (e.g., document.querySelector('a-camera')).
     * @param {object} [options] Optional parameters.
     * @param {boolean} [options.debug=false] Enable debug logging.
     */
    constructor(xrSession, glContext, xrRefSpace, aframeCameraEl, options = {}) {
        this.xrSession = xrSession;
        this.gl = glContext;
        this.xrRefSpace = xrRefSpace; // Correctly assigned
        this.aframeCameraEl = aframeCameraEl;

        if (!this.aframeCameraEl && options.debug) {
            console.warn(
                'CameraImageProvider: A-Frame camera element not provided. Pose capture for some APIs may fail.'
            );
        }

        this.options = { debug: false, ...options };

        this.processors = new Set();
        this.activeApiName = null;
        this.captureHelper = null;
        this.isCapturing = false;
        this.isPipelineBusy = false;

        this._onXRFrame = this._onXRFrame.bind(this);
        this._onGUMFrame = this._onGUMFrame.bind(this);

        // gl.makeXRCompatible() might be needed for WebXR Raw Camera helper
        // It's called here to ensure it's done before helper.init() which might use gl context.
        if (this.gl && this.xrSession) { // Only relevant if an XR session might use WebGL
            this.gl.makeXRCompatible().catch((err) => {
                console.error('CameraImageProvider: Could not make gl context XR compatible!', err);
                // This error might prevent WebXRRawCameraCaptureHelper from initializing successfully.
                // The helper's init method should handle this gracefully.
            });
        }

        // Attempt to detect and initialize the camera API asynchronously.
        // The actual start of capture will be triggered by processor registration
        // or if a GUM helper initializes and processors are already present.
        this._detectAndInitializeApi();
    }

    /**
     * Detects the most suitable camera API and initializes its capture helper.
     * @private
     */
    async _detectAndInitializeApi() {
        if (this.options.debug) console.log('CameraImageProvider: Detecting camera API using helpers...');
        this.activeApiName = null;
        this.captureHelper = null;

        const helperOptions = {
            debug: this.options.debug,
            glContext: this.gl,
            aframeCameraEl: this.aframeCameraEl,
            // xrRefSpace is passed directly to WebXRRawCameraCaptureHelper constructor where needed
        };

        // 1. WebARViewer (custom iOS browser like WebXRViewer/WebARViewer)
        //    Uses new xrSession.getComputerVisionData() API
        if (this.xrSession && WebARViewerCaptureHelper.isSupported(this.xrSession)) {
            if (this.options.debug) console.log('CameraImageProvider: Trying WebARViewerCaptureHelper...');
            const helper = new WebARViewerCaptureHelper(this.xrSession, this.aframeCameraEl, helperOptions);
            if (await helper.init()) { // init is async
                this.activeApiName = 'webar-viewer';
                this.captureHelper = helper;
                console.info(`CameraImageProvider: Initialized ${this.activeApiName}.`);
                // If processors are already registered, start the loop
                if (this.processors.size > 0 && !this.isCapturing) this._startCaptureLoop();
                return;
            }
            if (this.options.debug) console.log('CameraImageProvider: WebARViewerCaptureHelper init failed.');
        }


        // 2. WebXR Raw Camera Access API
        if (this.xrSession && this.gl && !this.captureHelper) {
            if (this.options.debug) console.log('CameraImageProvider: Trying WebXRRawCameraCaptureHelper...');
            if (WebXRRawCameraCaptureHelper.isSupported(this.xrSession, this.gl)) {
                // xrRefSpace is crucial for WebXR Raw Camera
                if (!this.xrRefSpace) {
                     console.warn('CameraImageProvider: xrRefSpace not available, cannot initialize WebXRRawCameraCaptureHelper.');
                } else {
                    const helper = new WebXRRawCameraCaptureHelper(this.xrSession, this.gl, this.xrRefSpace, this.aframeCameraEl, helperOptions);
                    if (await helper.init()) { // init is async
                        this.activeApiName = 'webxr-raw-camera';
                        this.captureHelper = helper;
                        console.info(`CameraImageProvider: Initialized ${this.activeApiName}.`);
                        if (this.processors.size > 0 && !this.isCapturing) this._startCaptureLoop();
                        return;
                    }
                     if (this.options.debug) console.log('CameraImageProvider: WebXRRawCameraCaptureHelper init failed.');
                }
            } else if (this.options.debug) {
                console.log('CameraImageProvider: WebXRRawCameraCaptureHelper not supported by browser/session.');
            }
        }

        // 3. AR Headset (using getUserMedia)
        const detectedHeadset = ARENAUtils.detectARHeadset();
        if (detectedHeadset !== 'unknown' && !this.captureHelper) {
            if (this.options.debug) console.log(`CameraImageProvider: Detected AR Headset (${detectedHeadset}). Trying GetUserMediaCaptureHelper (headset mode)...`);
            if (GetUserMediaCaptureHelper.isSupported()) {
                const headsetOptions = { ...helperOptions, isHeadset: true, requestedWidth: 640, requestedHeight: 480 /* Example defaults */ };
                const helper = new GetUserMediaCaptureHelper(this.aframeCameraEl, headsetOptions);
                try {
                    const success = await helper.init(); // GUM init is async
                    if (success && !this.captureHelper) { // Check captureHelper again in async callback
                        this.activeApiName = 'ar-headset-gum';
                        this.captureHelper = helper;
                        console.info(`CameraImageProvider: Initialized ${this.activeApiName}.`);
                        if (this.processors.size > 0 && !this.isCapturing) this._startCaptureLoop();
                        return; // Successfully initialized headset GUM
                    }
                    if (!success && this.options.debug) console.log('CameraImageProvider: AR Headset GUM helper failed to init, will try fallback GUM.');
                } catch (error) {
                    console.error('CameraImageProvider: Error initializing AR Headset GUM helper:', error);
                }
            } else if (this.options.debug) {
                console.log('CameraImageProvider: GetUserMedia not supported (for AR Headset).');
            }
        }

        // 4. Fallback to generic getUserMedia (WebAR)
        if (!this.captureHelper) {
            if (this.options.debug) console.log('CameraImageProvider: No specific helper succeeded or matched, trying Fallback GUM...');
            await this._tryFallbackGum(helperOptions); // Ensure this is awaited or handled if it sets state
        }

        // Final check after all attempts
        if (!this.captureHelper) {
            this._handleApiInitializationError('No suitable camera API could be initialized after all checks.');
        } else {
             if (this.options.debug) console.log(`CameraImageProvider: Detection complete. Active API: ${this.activeApiName}`);
        }
    }

    async _tryFallbackGum(helperOptions) {
        if (this.captureHelper) return; // Already initialized

        if (this.options.debug) console.log('CameraImageProvider: Trying Fallback GUM...');
        if (GetUserMediaCaptureHelper.isSupported()) {
            const gumOptions = { ...helperOptions, isHeadset: false, requestedWidth: 640, requestedHeight: 480 };
            const helper = new GetUserMediaCaptureHelper(this.aframeCameraEl, gumOptions);
            try {
                const success = await helper.init();
                if (success && !this.captureHelper) { // Check captureHelper again
                    this.activeApiName = 'webar-gum';
                    this.captureHelper = helper;
                    console.info(`CameraImageProvider: Initialized ${this.activeApiName} (fallback).`);
                    if (this.processors.size > 0 && !this.isCapturing) {
                        this._startCaptureLoop();
                    }
                } else if (!success) {
                    this._handleApiInitializationError('Fallback GUM helper failed to init.');
                }
            } catch (error) {
                console.error('CameraImageProvider: Error initializing Fallback GUM helper:', error);
                this._handleApiInitializationError('Fallback GUM helper failed with error.', error);
            }
        } else {
            if (this.options.debug) console.log('CameraImageProvider: GetUserMedia not supported (for Fallback GUM).');
            this._handleApiInitializationError('No suitable camera API could be initialized (GUM not supported).');
        }
    }


    _handleApiInitializationError(message, errorObj = null) {
        console.error(`CameraImageProvider: API Initialization Failed - ${message}`, errorObj || '');
        this.activeApiName = null;
        this.captureHelper = null;
        // TODO: Consider emitting an event that the CV system can listen to for failure.
        // Example: this.aframeCameraEl.emit('camera-provider-failed', { message }, false);
    }

    registerProcessor(processor) {
        if (typeof processor.processImage !== 'function') {
            console.error(
                'CameraImageProvider: Processor must implement processImage(imageData, metadata) that returns a Promise.'
            );
            return;
        }
        this.processors.add(processor);

        if (this.captureHelper) { // A helper is initialized
            if (!this.isCapturing && this.processors.size > 0) {
                if (this.options.debug) {
                    console.log(
                        `CameraImageProvider: First processor registered with active API ('${this.activeApiName}'). Starting capture loop.`
                    );
                }
                this._startCaptureLoop();
            } else if (this.options.debug) {
                console.log(
                    `CameraImageProvider: Processor registered. API ('${this.activeApiName}') active. Capture loop already running or no processors yet.`
                );
            }
        } else if (this.options.debug) {
            console.log(
                'CameraImageProvider: Processor registered, but no camera API/helper is active yet. Capture loop will not start until API detection completes.'
            );
        }
    }

    unregisterProcessor(processor) {
        this.processors.delete(processor);
        if (this.isCapturing && this.processors.size === 0) {
            this._stopCaptureLoop();
        }
    }

    _startCaptureLoop() {
        if (this.isCapturing || !this.captureHelper) {
            if (this.options.debug) {
                console.warn(
                    `CameraImageProvider: Start loop called but conditions not met. Capturing: ${this.isCapturing}, Helper: ${!!this.captureHelper}`
                );
            }
            return;
        }
        this.isCapturing = true;
        if (this.options.debug) {
            console.info(
                `CameraImageProvider: Starting capture loop for API: ${this.activeApiName}. Helper uses XRFrame: ${this.captureHelper.usesXRFrame}`
            );
        }

        // Call helper's startStreaming method, which is part of BaseCaptureHelper
        if (typeof this.captureHelper.startStreaming === 'function') {
            this.captureHelper.startStreaming();
        }


        if (this.captureHelper.usesXRFrame) {
            if (this.xrSession) {
                this.xrSession.requestAnimationFrame(this._onXRFrame);
            } else {
                console.error(
                    `CameraImageProvider: XR session not available for API '${this.activeApiName}'. Cannot start XR frame loop.`
                );
                this.isCapturing = false;
                if (typeof this.captureHelper.stopStreaming === 'function') this.captureHelper.stopStreaming();
            }
        } else { // GUM or other non-XRFrame based helpers
            window.requestAnimationFrame(this._onGUMFrame);
        }
    }

    _stopCaptureLoop() {
        if (!this.isCapturing) return;
        this.isCapturing = false;
        if (this.options.debug) console.info(`CameraImageProvider: Stopping capture loop for API: ${this.activeApiName}.`);
        if (this.captureHelper && typeof this.captureHelper.stopStreaming === 'function') {
            this.captureHelper.stopStreaming();
        }
    }

    async _onXRFrame(time, frame) {
        if (!this.isCapturing || !this.xrSession || !this.captureHelper || !this.captureHelper.usesXRFrame) {
            if (this.isCapturing && this.options.debug) {
                console.warn('CameraImageProvider: _onXRFrame called but conditions not met or helper changed.');
            }
            this.isCapturing = false; // Stop if state is inconsistent
            return;
        }
        this.xrSession.requestAnimationFrame(this._onXRFrame);

        if (this.processors.size === 0 || this.isPipelineBusy) {
            // if (this.isPipelineBusy && this.options.debug) console.log('CameraImageProvider: Pipeline busy, XR frame dropped.');
            return;
        }
        
        let acquiredFrameData = null;
        // Moved pose acquisition inside try block as it's part of frame processing
        try {
            if (!this.xrRefSpace) {
                console.warn('CameraImageProvider: xrRefSpace not available for XR frame.');
                return;
            }
            const pose = frame.getViewerPose(this.xrRefSpace);
            if (!pose) {
                if (this.options.debug) console.warn('CameraImageProvider: No viewer pose for XR frame.');
                return;
            }
            acquiredFrameData = await this.captureHelper.getFrameData(time, frame, pose);
        } catch (error) {
            console.error(`CameraImageProvider: Error in getFrameData for ${this.activeApiName}:`, error);
            return; 
        }


        if (acquiredFrameData) {
            this._distributeFrameToProcessors(acquiredFrameData.imageData, acquiredFrameData.metadata);
        } else if (this.options.debug) {
            // console.log('CameraImageProvider: No data acquired from helper in _onXRFrame.');
        }
    }

    async _onGUMFrame(time) {
        if (!this.isCapturing || !this.captureHelper || this.captureHelper.usesXRFrame) {
             if (this.isCapturing && this.options.debug) {
                console.warn('CameraImageProvider: _onGUMFrame called but conditions not met or helper changed.');
            }
            this.isCapturing = false; // Stop if state is inconsistent
            return;
        }
        window.requestAnimationFrame(this._onGUMFrame);

        if (this.processors.size === 0 || this.isPipelineBusy) {
            // if (this.isPipelineBusy && this.options.debug) console.log('CameraImageProvider: Pipeline busy, GUM frame dropped.');
            return;
        }

        let acquiredFrameData = null;
        try {
            acquiredFrameData = await this.captureHelper.getFrameData(time);
        } catch (error) {
            console.error(
                `CameraImageProvider: Error in GUM getFrameData for ${this.activeApiName}:`,
                error
            );
            return;
        }

        if (acquiredFrameData) {
            this._distributeFrameToProcessors(acquiredFrameData.imageData, acquiredFrameData.metadata);
        } else if (this.options.debug) {
            // console.log('CameraImageProvider: No data acquired from helper in _onGUMFrame.');
        }
    }

    _distributeFrameToProcessors(imageData, metadata) {
        if (!imageData || !metadata) {
            if (this.options.debug) console.warn('CameraImageProvider: No image data or metadata to distribute.');
            return;
        }

        this.isPipelineBusy = true;
        const processingPromises = [];
        for (const processor of this.processors) {
            processingPromises.push(
                processor.processImage(imageData, metadata).catch((err) => {
                    console.error(
                        'CameraImageProvider: Error in a processor:',
                        processor.constructor ? processor.constructor.name : 'UnknownProcessor',
                        err
                    );
                    return null;
                })
            );
        }

        Promise.all(processingPromises).finally(() => {
            this.isPipelineBusy = false;
        });
    }

    destroy() {
        if (this.options.debug) console.info('CameraImageProvider: Destroying...');
        this._stopCaptureLoop();
        if (this.captureHelper && typeof this.captureHelper.destroy === 'function') {
            this.captureHelper.destroy();
        }
        this.processors.clear();
        
        this.captureHelper = null;
        this.activeApiName = null;
        this.xrSession = null;
        // this.gl = null; // GL context is typically owned by A-Frame renderer
        this.xrRefSpace = null;
        this.aframeCameraEl = null;
        this.isPipelineBusy = false;
        if (this.options.debug) console.info('CameraImageProvider: Destroyed.');
    }
}
