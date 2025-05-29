// Investigation of src/systems/armarker/camera-capture/ccwebarviewer.js:
// - Raw image format: Receives frame data via a global `window.processCV(frame)` function.
//   The `frame` object contains `_buffers` (array of image planes) and `_pixelFormat` (e.g., "YUV420P").
//   Each buffer in `_buffers` has a `_buffer` property which is a base64-encoded string of the image plane data.
// - Processing:
//   - `Base64Binary.decodeArrayBuffer` is used to decode the base64 string into an ArrayBuffer.
//   - This ArrayBuffer is then converted to a Uint8Array (e.g., `this.yByteArray`).
//   - For grayscale, the Y-plane data (`this.yByteArray`) is directly copied to `this.frameGsPixels`.
//   - For color (if `this.colorCV` is true), the UV plane data is also decoded.
//   - An offscreen canvas (`this.canvas`, `this.offScreenImageData`) is used for potential color conversion (YUV to RGB)
//     and display/debugging, but the primary output for the CV worker is the grayscale Y-plane.
// - Data to CV Worker: Message with { type: CVWorkerMsgs.type.PROCESS_GSFRAME, ts, width, height, grayscalePixels, camera }.
//   - `grayscalePixels` is the Uint8Array containing the Y-plane data.
//   - `camera` contains intrinsics (fx, fy, cx, cy, gamma=0) derived from `frame._camera.cameraIntrinsics`.
//
// WebARViewer new API (from previous tasks, not the one used here):
// - xrSession.getComputerVisionData()
// - xrSession.getCameraIntrinsics()
// This helper will now primarily use the global window.processCV (legacy/original WebARViewer API)

import BaseCaptureHelper from './base-capture-helper.js';
const THREE = AFRAME.THREE;

export default class WebARViewerCaptureHelper extends BaseCaptureHelper {
    constructor(xrSession, aframeCameraEl = null, options = {}, providerInterface = null) {
        super(xrSession, null, aframeCameraEl, options); 
        this.providerInterface = providerInterface;

        this.gl = null; 
        this.frameWidth = 0;
        this.frameHeight = 0;
        this.rgbaBuffer = null; 
        this.fb = null; 
        this.cachedCameraIntrinsics = null; // To store intrinsics from xrSession or cvFrame

        // Reusable THREE.Matrix4 instances
        this.reusableWorldPose = new THREE.Matrix4();
        this.reusableViewTransformMatrix = new THREE.Matrix4();

        this._handleProcessCV = this._handleProcessCV.bind(this);

        this.debug = this.options.debug || false;
        if (this.debug) {
            console.log('WebARViewerCaptureHelper: Constructor options:', this.options);
        }
    }

    static isSupported(xrSession) {
        // Check for the global processCV function and the newer WebXRViewer API
        // but prioritize window.processCV if available for this helper's path.
        const globalProcessCVExists = typeof window.processCV === 'function';
        const webkitHandlerExists = (typeof window.webkit !== 'undefined' && 
                                    typeof window.webkit.messageHandlers !== 'undefined' && 
                                    typeof window.webkit.messageHandlers.WebXRViewer !== 'undefined');
        
        // If xrSession is provided, also check for its specific methods as a fallback/alternative.
        const xrSessionAPIsExist = !!(xrSession &&
                                    typeof xrSession.getCameraIntrinsics === 'function' &&
                                    (typeof xrSession.getComputerVisionData === 'function' || globalProcessCVExists || webkitHandlerExists));
        
        // This helper, as refactored, will rely on window.processCV.
        // isSupported should reflect the primary mechanism it will use.
        return globalProcessCVExists || webkitHandlerExists || xrSessionAPIsExist;
    }

    async init() {
        if (this.isCapturing) { 
            if (this.debug) console.log('WebARViewerCaptureHelper: Already initialized.');
            return true;
        }
        // xrSession is not strictly required if window.processCV is the sole mechanism.
        // However, if using xrSession.getCameraIntrinsics, it's needed.
        if (!WebARViewerCaptureHelper.isSupported(this.xrSession)) { // Pass xrSession for comprehensive check
            console.error('WebARViewerCaptureHelper: Required API (window.processCV or xrSession methods) not detected.');
            return false;
        }

        // If xrSession is available and has getCameraIntrinsics, cache them.
        // This is a bit of a hybrid approach: use window.processCV for frame data,
        // but xrSession.getCameraIntrinsics if available.
        if (this.xrSession && typeof this.xrSession.getCameraIntrinsics === 'function') {
            try {
                this.cachedCameraIntrinsics = this.xrSession.getCameraIntrinsics();
                if (!this.cachedCameraIntrinsics && this.debug) {
                     console.warn('WebARViewerCaptureHelper: Could not cache initial camera intrinsics from xrSession.');
                } else if (this.debug) {
                    console.log('WebARViewerCaptureHelper: Cached camera intrinsics from xrSession.');
                }
            } catch (error) {
                 if (this.debug) console.warn('WebARViewerCaptureHelper: Error caching intrinsics from xrSession:', error);
            }
        }
        
        // GL context might be needed for displayTexture conversion if that path is used
        // inside _handleProcessCV.
        if (this.xrSession && this.xrSession.glContext) {
            this.gl = this.xrSession.glContext;
        } else if (this.options.glContext) {
            this.gl = this.options.glContext;
        }
        if (!this.gl && this.debug) {
            console.warn('WebARViewerCaptureHelper: No WebGL context. displayTexture conversion might fail if needed.');
        }

        this.isCapturing = true; 
        if (this.debug) console.log('WebARViewerCaptureHelper: Initialized successfully. Ready for window.processCV.');
        return true;
    }
    
    // Helper for WebGL texture to RGBA (assumes previous implementation or similar)
    async convertToRGBAFromDisplayTexture(displayTexture, targetRgbaBuffer) {
        if (!this.gl || !displayTexture) return false;
        if (!this.fb) this.fb = this.gl.createFramebuffer();
        
        const previousFramebuffer = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fb);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, displayTexture, 0);
        
        const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
        let success = false;
        if (status === this.gl.FRAMEBUFFER_COMPLETE) {
            this.gl.readPixels(0, 0, this.frameWidth, this.frameHeight, this.gl.RGBA, this.gl.UNSIGNED_BYTE, targetRgbaBuffer);
            success = true;
        } else {
            console.error('WebARViewerCaptureHelper: Framebuffer not complete for displayTexture. Status:', status);
        }
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, previousFramebuffer);
        return success;
    }

    // Helper for software buffer to RGBA (assumes previous implementation or similar)
    // This is a simplified placeholder. The actual _softwareNV21toRGBA is more complex.
    _softwareBufferToRGBA(buffer, targetRgbaBuffer, width, height) {
        // Assuming buffer is NV21, use the existing _softwareNV21toRGBA
        // The cvFrame might have a 'format' property.
        // For now, directly calling the NV21 one if format implies it.
        // The cvFrame object passed to _handleProcessCV should have a format field.
        // This is a simplified call; actual logic might need to check cvFrame.format.
        if (buffer && buffer.byteLength >= width * height * 1.5) { // Basic check for NV21 size
             const yPlaneSize = width * height;
             const yBuffer = new Uint8Array(buffer, 0, yPlaneSize);
             const vuBuffer = new Uint8Array(buffer, yPlaneSize);
             this._softwareNV21toRGBA(yBuffer, vuBuffer, width, height, targetRgbaBuffer);
             return true;
        }
        console.warn("WebARViewerCaptureHelper: Software buffer conversion failed or format not supported.");
        return false;
    }


    // Copied from previous implementation to be self-contained here
    _softwareNV21toRGBA(yBuffer, vuBuffer, width, height, targetRgbaBuffer) {
        const yPlaneSize = width * height;
        if (yBuffer.byteLength < yPlaneSize || vuBuffer.byteLength < yPlaneSize / 2) {
            console.error("WebARViewerCaptureHelper: Buffer sizes are too small for NV21 conversion.");
            return;
        }
        for (let j = 0; j < height; j++) {
            for (let i = 0; i < width; i++) {
                const y = yBuffer[j * width + i];
                const vuOffset = Math.floor(j / 2) * width + Math.floor(i / 2) * 2;
                const v = vuBuffer[vuOffset];     
                const u = vuBuffer[vuOffset + 1]; 
                let r = y + 1.402 * (v - 128);
                let g = y - 0.344136 * (u - 128) - 0.714136 * (v - 128);
                let b = y + 1.772 * (u - 128);
                const outputIndex = (j * width + i) * 4;
                targetRgbaBuffer[outputIndex]     = Math.max(0, Math.min(255, r));
                targetRgbaBuffer[outputIndex + 1] = Math.max(0, Math.min(255, g));
                targetRgbaBuffer[outputIndex + 2] = Math.max(0, Math.min(255, b));
                targetRgbaBuffer[outputIndex + 3] = 255; 
            }
        }
    }


    async _handleProcessCV(cvFrame) {
        if (!this.isCapturing || !super.isStreaming || !cvFrame) { // Check super.isStreaming
            return;
        }
 
        // If intrinsics not cached via xrSession.getCameraIntrinsics() during init,
        // try to get them from the cvFrame itself (original WebARViewer behavior).
        if (!this.cachedCameraIntrinsics && cvFrame._camera && cvFrame._camera.cameraIntrinsics) {
            const ci = cvFrame._camera.cameraIntrinsics;
            this.cachedCameraIntrinsics = {
                fx: ci[0], fy: ci[4], cx: ci[6], cy: ci[7], gamma: 0,
                projectionMatrix: cvFrame._camera.projectionMatrix, // Assuming this is also provided
            };
            if (this.options.debug) console.log('WebARViewerCaptureHelper: Cached camera intrinsics from cvFrame.');
        } else if (!this.cachedCameraIntrinsics && this.xrSession && typeof this.xrSession.getCameraIntrinsics === 'function'){
            // Fallback to try getting from xrSession again if not available from cvFrame._camera
             try {
                this.cachedCameraIntrinsics = this.xrSession.getCameraIntrinsics();
             } catch (e) { /* ignore */ }
        }


        if (!this.cachedCameraIntrinsics || !this.cachedCameraIntrinsics.projectionMatrix) {
             if (this.options.debug) console.warn('WebARViewerCaptureHelper: Missing camera intrinsics or projection matrix.');
             return;
        }
 
        // Extract data from cvFrame, which matches the new API structure for its fields
        // This means window.processCV is now expected to pass a frame in the new format.
        // If it's the old format (base64 buffers), this part needs significant adaptation.
        // Assuming cvFrame structure is: { width, height, buffer, textureY, textureCbCr, displayTexture, cameraViewMatrix, timestamp, _camera (for old intrinsics) }
        
        const { width, height, buffer, textureY, textureCbCr, displayTexture, cameraViewMatrix, timestamp } = cvFrame;
        this.frameWidth = width; 
        this.frameHeight = height;
 
        const currentBufferSize = this.frameWidth * this.frameHeight * 4;
        if (!this.rgbaBuffer || this.rgbaBuffer.length !== currentBufferSize) {
            this.rgbaBuffer = new Uint8ClampedArray(currentBufferSize);
        }
 
        let conversionSuccess = false;
        let originalFormat = 'WebARViewer_Unknown';

        if (displayTexture && this.gl) {
            conversionSuccess = await this.convertToRGBAFromDisplayTexture(displayTexture, this.rgbaBuffer);
            if (conversionSuccess) originalFormat = 'WebARViewer_DisplayTexture';
        }
        
        // The cvFrame.buffer here is assumed to be in a format like NV21 if not displayTexture
        if (!conversionSuccess && buffer) { 
            // Assuming buffer is NV21 or similar. cvFrame should ideally have a 'format' field.
            // Let's assume _softwareBufferToRGBA checks format or defaults to NV21.
            conversionSuccess = this._softwareBufferToRGBA(buffer, this.rgbaBuffer, this.frameWidth, this.frameHeight);
            if (conversionSuccess) originalFormat = 'WebARViewer_Buffer_NV21'; // Be more specific if possible
        }
        
        if (!conversionSuccess) {
            if (this.options.debug) console.warn('WebARViewerCaptureHelper: Failed to convert image to RGBA.');
            return;
        }
 
        this.reusableViewTransformMatrix.fromArray(cameraViewMatrix);
        this.reusableWorldPose.copy(this.reusableViewTransformMatrix).invert();
        
        const projM = new Float32Array(this.cachedCameraIntrinsics.projectionMatrix); 
        const intrinsics = {
            fx: this.cachedCameraIntrinsics.fx,
            fy: this.cachedCameraIntrinsics.fy,
            cx: this.cachedCameraIntrinsics.cx,
            cy: this.cachedCameraIntrinsics.cy,
            gamma: this.cachedCameraIntrinsics.gamma || 0,
        };
 
        const frameData = {
            imageData: {
                buffer: this.rgbaBuffer,
                width: this.frameWidth,
                height: this.frameHeight,
                format: 'RGBA',
                originalFormat: originalFormat,
            },
            metadata: {
                timestamp: timestamp || performance.now(), 
                worldPose: this.reusableWorldPose,
                cameraIntrinsics: intrinsics,
                projectionMatrix: projM,
                viewTransformMatrix: this.reusableViewTransformMatrix
            }
        };
 
        if (this.providerInterface && typeof this.providerInterface.distributeFrameData === 'function') {
            this.providerInterface.distributeFrameData(frameData);
        }
    }

    startStreaming() { 
        super.startStreaming(); // Sets this.isStreaming = true
        if (this.isCapturing && WebARViewerCaptureHelper.isSupported(this.xrSession)) { // Check isSupported again
            if (typeof window.processCV !== 'undefined' && this.options.debug && window.processCV !== this._handleProcessCV) {
                console.warn('WebARViewerCaptureHelper: window.processCV is already defined by another handler. Overwriting.');
            }
            window.processCV = this._handleProcessCV;
            
            if (this.xrSession && typeof this.xrSession.initComputerVision === 'function') {
                try {
                    this.xrSession.initComputerVision();
                } catch (e) {
                    if (this.options.debug) console.warn("Error calling xrSession.initComputerVision():", e);
                }
            }
            if (this.options.debug) console.log('WebARViewerCaptureHelper: window.processCV set and streaming started.');
        } else if (this.options.debug) {
            console.warn('WebARViewerCaptureHelper: Could not start streaming for window.processCV. Conditions not met.');
        }
    }

    stopStreaming() { 
        super.stopStreaming(); // Sets this.isStreaming = false
        if (window.processCV === this._handleProcessCV) {
            window.processCV = undefined; // Or restore previous if saved
            if (this.options.debug) console.log('WebARViewerCaptureHelper: window.processCV cleared.');
        }
        if (this.xrSession && typeof this.xrSession.stopComputerVision === 'function') {
            try {
                this.xrSession.stopComputerVision();
            } catch (e) {
                if (this.options.debug) console.warn("Error calling xrSession.stopComputerVision():", e);
            }
        }
    }
    
    // getFrameData is removed as per instructions.
    // async getFrameData(time, frame = null, pose = null) { return null; }


    destroy() {
        if (this.debug) console.log('WebARViewerCaptureHelper: Destroying...');
        this.stopStreaming(); // Ensure window.processCV is cleared

        if (this.gl && this.fb) {
            try { this.gl.deleteFramebuffer(this.fb); } 
            catch (e) { console.error('WebARViewerCaptureHelper: Error deleting framebuffer:', e); }
        }
        this.fb = null;
        this.rgbaBuffer = null;
        this.cachedCameraIntrinsics = null;
        
        super.destroy(); 

        if (this.debug) console.log('WebARViewerCaptureHelper: Destroyed.');
    }
}

WebARViewerCaptureHelper.prototype.usesXRFrame = false; // Data is pushed via window.processCV
// WebARViewerCaptureHelper.isSupported = WebARViewerCaptureHelper.isSupported; // Static methods inherit.
