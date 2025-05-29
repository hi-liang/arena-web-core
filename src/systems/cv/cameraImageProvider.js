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
        this.xrRefSpace = xrRefSpace; 
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
        this.distributeFrameData = this.distributeFrameData.bind(this); // Bind new method

        if (this.gl && this.xrSession) { 
            this.gl.makeXRCompatible().catch((err) => {
                console.error('CameraImageProvider: Could not make gl context XR compatible!', err);
            });
        }
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
        };
        
        const providerInterface = {
            distributeFrameData: this.distributeFrameData,
        };

        if (this.xrSession && WebARViewerCaptureHelper.isSupported(this.xrSession)) {
            if (this.options.debug) console.log('CameraImageProvider: Trying WebARViewerCaptureHelper...');
            // Pass providerInterface to WebARViewerCaptureHelper
            const helper = new WebARViewerCaptureHelper(this.xrSession, this.aframeCameraEl, helperOptions, providerInterface);
            if (await helper.init()) { 
                this.activeApiName = 'webar-viewer';
                this.captureHelper = helper;
                console.info(`CameraImageProvider: Initialized ${this.activeApiName}.`);
                if (this.processors.size > 0 && !this.isCapturing) this._startCaptureLoop();
                return;
            }
            if (this.options.debug) console.log('CameraImageProvider: WebARViewerCaptureHelper init failed.');
        }

        if (this.xrSession && this.gl && !this.captureHelper) {
            if (this.options.debug) console.log('CameraImageProvider: Trying WebXRRawCameraCaptureHelper...');
            if (WebXRRawCameraCaptureHelper.isSupported(this.xrSession, this.gl)) {
                if (!this.xrRefSpace) {
                     console.warn('CameraImageProvider: xrRefSpace not available, cannot initialize WebXRRawCameraCaptureHelper.');
                } else {
                    const helper = new WebXRRawCameraCaptureHelper(this.xrSession, this.gl, this.xrRefSpace, this.aframeCameraEl, helperOptions);
                    if (await helper.init()) { 
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

        const detectedHeadset = ARENAUtils.detectARHeadset();
        if (detectedHeadset !== 'unknown' && !this.captureHelper) {
            if (this.options.debug) console.log(`CameraImageProvider: Detected AR Headset (${detectedHeadset}). Trying GetUserMediaCaptureHelper (headset mode)...`);
            if (GetUserMediaCaptureHelper.isSupported()) {
                const headsetOptions = { ...helperOptions, isHeadset: true, requestedWidth: 640, requestedHeight: 480 };
                // Pass providerInterface to GetUserMediaCaptureHelper
                const helper = new GetUserMediaCaptureHelper(this.aframeCameraEl, headsetOptions, providerInterface);
                try {
                    const success = await helper.init(); 
                    if (success && !this.captureHelper) { 
                        this.activeApiName = 'ar-headset-gum';
                        this.captureHelper = helper;
                        console.info(`CameraImageProvider: Initialized ${this.activeApiName}.`);
                        if (this.processors.size > 0 && !this.isCapturing) this._startCaptureLoop();
                        return; 
                    }
                    if (!success && this.options.debug) console.log('CameraImageProvider: AR Headset GUM helper failed to init, will try fallback GUM.');
                } catch (error) {
                    console.error('CameraImageProvider: Error initializing AR Headset GUM helper:', error);
                }
            } else if (this.options.debug) {
                console.log('CameraImageProvider: GetUserMedia not supported (for AR Headset).');
            }
        }

        if (!this.captureHelper) {
            if (this.options.debug) console.log('CameraImageProvider: No specific helper succeeded or matched, trying Fallback GUM...');
            await this._tryFallbackGum(helperOptions, providerInterface); 
        }

        if (!this.captureHelper) {
            this._handleApiInitializationError('No suitable camera API could be initialized after all checks.');
        } else {
             if (this.options.debug) console.log(`CameraImageProvider: Detection complete. Active API: ${this.activeApiName}`);
        }
    }

    async _tryFallbackGum(helperOptions, providerInterface) { // Added providerInterface parameter
        if (this.captureHelper) return; 

        if (this.options.debug) console.log('CameraImageProvider: Trying Fallback GUM...');
        if (GetUserMediaCaptureHelper.isSupported()) {
            const gumOptions = { ...helperOptions, isHeadset: false, requestedWidth: 640, requestedHeight: 480 };
            // Pass providerInterface to GetUserMediaCaptureHelper
            const helper = new GetUserMediaCaptureHelper(this.aframeCameraEl, gumOptions, providerInterface);
            try {
                const success = await helper.init();
                if (success && !this.captureHelper) { 
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
    }

    registerProcessor(processor) {
        if (typeof processor.processImage !== 'function') {
            console.error(
                'CameraImageProvider: Processor must implement processImage(imageData, metadata) that returns a Promise.'
            );
            return;
        }
        this.processors.add(processor);

        if (this.captureHelper) { 
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

        if (this.captureHelper && this.captureHelper.usesXRFrame) {
            if (this.xrSession) {
                this.xrSession.requestAnimationFrame(this._onXRFrame);
            } else {
                console.error(
                    `CameraImageProvider: XR session not available for API '${this.activeApiName}'. Cannot start XR frame loop.`
                );
                this.isCapturing = false; 
            }
        } else if (this.captureHelper && !this.captureHelper.usesXRFrame) {
            if (typeof this.captureHelper.startStreaming === 'function') {
                this.captureHelper.startStreaming(); 
            } else {
                console.warn(
                    `CameraImageProvider: Active helper ${this.activeApiName} is non-XRFrame but has no startStreaming method.`
                );
                this.isCapturing = false; 
            }
        } else { 
            console.warn('CameraImageProvider: No active or valid capture helper to start capture loop for.');
            this.isCapturing = false; 
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
            this.isCapturing = false; 
            return;
        }
        this.xrSession.requestAnimationFrame(this._onXRFrame);

        if (this.processors.size === 0 || this.isPipelineBusy) {
            return;
        }
        
        let acquiredFrameData = null;
        try {
            acquiredFrameData = await this.captureHelper.getFrameData(time, frame);
        } catch (error) {
            console.error(`CameraImageProvider: Error in getFrameData for ${this.activeApiName}:`, error);
            return; 
        }

        if (acquiredFrameData) {
            this.isPipelineBusy = true; // Set busy before distributing
            this._distributeFrameToProcessors(acquiredFrameData.imageData, acquiredFrameData.metadata);
        } else if (this.options.debug) {
            // console.log('CameraImageProvider: No data acquired from helper in _onXRFrame.');
        }
    }
    
    /**
     * Called by capture helpers that manage their own frame loops (e.g., GetUserMedia, WebARViewer)
     * to push frame data into the processing pipeline.
     * @param {FrameData} frameData - The frame data object containing imageData and metadata.
     */
    distributeFrameData(frameData) {
        if (!this.isCapturing) { // If provider was stopped, ignore incoming frames
            return;
        }

        if (this.processors.size === 0) {
            // No processors registered, nothing to do.
            return;
        }

        if (this.isPipelineBusy) {
            if (this.options.debug) {
                console.log('CameraImageProvider: Pipeline busy, frame dropped from external helper.');
            }
            return;
        }

        if (!frameData || !frameData.imageData || !frameData.metadata) {
            if (this.options.debug) {
                console.warn('CameraImageProvider: Invalid frameData received in distributeFrameData.');
            }
            return;
        }

        this.isPipelineBusy = true; // Set busy flag before starting processing
        this._distributeFrameToProcessors(frameData.imageData, frameData.metadata);
    }


    _distributeFrameToProcessors(imageData, metadata) {
        if (!imageData || !metadata) {
            if (this.options.debug) console.warn('CameraImageProvider: No image data or metadata to distribute.');
            // Ensure pipeline busy is reset if we bail early here due to bad data
            // This should ideally not happen if checks are done before calling this.
            this.isPipelineBusy = false; 
            return;
        }

        // this.isPipelineBusy = true; // Removed from here

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
        this.xrRefSpace = null;
        this.aframeCameraEl = null;
        this.isPipelineBusy = false;
        if (this.options.debug) console.info('CameraImageProvider: Destroyed.');
    }
}
