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
// New API (based on task description for WebARViewerCaptureHelper):
// - xrSession.getComputerVisionData() -> returns object with { width, height, buffer, textureY, textureCbCr, displayTexture, cameraViewMatrix, timestamp }
// - xrSession.getCameraIntrinsics() -> returns object with { fx, fy, cx, cy, projectionMatrix }

import BaseCaptureHelper from './base-capture-helper.js';
const THREE = AFRAME.THREE;

export default class WebARViewerCaptureHelper extends BaseCaptureHelper {
    constructor(xrSession, aframeCameraEl = null, options = {}) {
        super(xrSession, null, aframeCameraEl, options); 

        // this.isCapturing = false; // Managed by BaseCaptureHelper
        this.gl = null; 
        this.frameWidth = 0;
        this.frameHeight = 0;
        this.rgbaBuffer = null; 

        this.yTexture = null;
        this.cbcrTexture = null;
        this.displayTexture = null; 

        this.cvData = null; 
        this.fb = null; 

        // Reusable THREE.Matrix4 instances
        this.reusableWorldPose = new THREE.Matrix4();
        this.reusableViewTransformMatrix = new THREE.Matrix4();
        // projectionMatrix is typically Float32Array from API, not reused as THREE.Matrix4 here

        this.debug = this.options.debug || false;
        if (this.debug) {
            console.log('WebARViewerCaptureHelper: Constructor options:', this.options);
        }
    }

    static isSupported(xrSession) {
        return !!(
            xrSession &&
            typeof xrSession.getComputerVisionData === 'function' &&
            typeof xrSession.getCameraIntrinsics === 'function'
        );
    }

    async init() {
        if (this.isCapturing) { // isCapturing is from BaseCaptureHelper
            if (this.debug) console.log('WebARViewerCaptureHelper: Already initialized.');
            return true;
        }
        if (!this.xrSession) {
            console.error('WebARViewerCaptureHelper: xrSession not provided for init.');
            return false;
        }

        if (!WebARViewerCaptureHelper.isSupported(this.xrSession)) {
            console.error('WebARViewerCaptureHelper: xrSession does not support required computer vision APIs.');
            return false;
        }

        this.gl = this.xrSession.glContext || this.options.glContext || null;
        if (!this.gl && this.debug) {
            console.warn('WebARViewerCaptureHelper: No WebGL context available. displayTexture readback will not be possible.');
        }

        try {
            const initialIntrinsics = this.xrSession.getCameraIntrinsics();
            if (!initialIntrinsics || !initialIntrinsics.projectionMatrix) {
                console.error('WebARViewerCaptureHelper: Failed to get valid initial camera intrinsics.');
                return false;
            }
            if (this.debug) console.log('WebARViewerCaptureHelper: Initial camera intrinsics obtained.');
        } catch (error) {
            console.error('WebARViewerCaptureHelper: Error during init while checking camera intrinsics:', error);
            return false;
        }

        this.isCapturing = true; // Mark as initialized
        // super.startStreaming(); // Streaming starts when CameraImageProvider calls startStreaming
        // BaseCaptureHelper.isStreaming will be used to gate getFrameData

        if (this.debug) console.log('WebARViewerCaptureHelper: Initialized successfully.');
        return true;
    }

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

    async getFrameData(time, frame = null, pose = null) { 
        if (!this.isCapturing || !super.isStreaming || !this.xrSession) {
            if (this.debug && (!this.isCapturing || !super.isStreaming)) {
                 // console.warn('WebARViewerCaptureHelper: Not capturing or streaming.');
            }
            return null;
        }

        try {
            this.cvData = this.xrSession.getComputerVisionData();
        } catch (error) {
            console.error('WebARViewerCaptureHelper: Error calling getComputerVisionData():', error);
            return null;
        }

        if (!this.cvData) {
            if (this.debug) console.warn('WebARViewerCaptureHelper: getComputerVisionData() returned null.');
            return null;
        }

        let cameraIntrinsicsObj;
        try {
            cameraIntrinsicsObj = this.xrSession.getCameraIntrinsics();
        } catch (error) {
            console.error('WebARViewerCaptureHelper: Error calling getCameraIntrinsics():', error);
            return null;
        }

        if (!cameraIntrinsicsObj || !cameraIntrinsicsObj.projectionMatrix || !this.cvData.cameraViewMatrix) {
            console.error('WebARViewerCaptureHelper: Missing camera intrinsics or view matrix.');
            return null;
        }

        this.frameWidth = this.cvData.width || 0;
        this.frameHeight = this.cvData.height || 0;

        if (this.frameWidth === 0 || this.frameHeight === 0) {
            console.warn('WebARViewerCaptureHelper: Frame dimensions are zero.');
            return null;
        }

        const requiredRgbaBufferSize = this.frameWidth * this.frameHeight * 4;
        if (!this.rgbaBuffer || this.rgbaBuffer.byteLength !== requiredRgbaBufferSize) {
            this.rgbaBuffer = new Uint8ClampedArray(requiredRgbaBufferSize);
            if (this.debug) console.log(`WebARViewerCaptureHelper: RGBA buffer resized to ${this.frameWidth}x${this.frameHeight}`);
        }

        let originalFormat = 'WebARViewerFormat_Unknown';

        if (this.cvData.displayTexture && this.gl) {
            if (!this.fb) this.fb = this.gl.createFramebuffer();
            const previousFramebuffer = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fb);
            this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.cvData.displayTexture, 0);
            const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
            if (status === this.gl.FRAMEBUFFER_COMPLETE) {
                this.gl.readPixels(0, 0, this.frameWidth, this.frameHeight, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.rgbaBuffer);
                originalFormat = 'YCbCr_via_displayTexture_to_RGBA';
                 if (this.debug) console.log('WebARViewerCaptureHelper: Read RGBA from displayTexture.');
            } else {
                console.error('WebARViewerCaptureHelper: Framebuffer not complete for displayTexture. Status:', status);
                 this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, previousFramebuffer); 
            }
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, previousFramebuffer); 
        } else if (this.cvData.textureY && this.cvData.textureCbCr && this.gl) {
            console.warn('WebARViewerCaptureHelper: YCbCr WebGL textures provided, but GPU conversion shader is not implemented. Returning no image data.');
            originalFormat = 'YCbCr_WebGLTextures_Raw';
            return null; 
        } else if (this.cvData.buffer) {
            if (this.cvData.format === 'NV21' || (!this.cvData.format && this.debug)) { 
                 if (this.debug && !this.cvData.format) console.warn("WebARViewerCaptureHelper: cvData.format is missing, assuming NV21 for buffer conversion.");
                const yPlaneSize = this.frameWidth * this.frameHeight;
                if (this.cvData.buffer.byteLength >= yPlaneSize + yPlaneSize / 2) {
                    const yBuffer = new Uint8Array(this.cvData.buffer, 0, yPlaneSize);
                    const vuBuffer = new Uint8Array(this.cvData.buffer, yPlaneSize);
                    this._softwareNV21toRGBA(yBuffer, vuBuffer, this.frameWidth, this.frameHeight, this.rgbaBuffer);
                    originalFormat = 'NV21_Buffer_to_RGBA_Software';
                    if (this.debug) console.log('WebARViewerCaptureHelper: Converted NV21 buffer to RGBA via software.');
                } else {
                     console.error('WebARViewerCaptureHelper: NV21 buffer size is incorrect.');
                     return null;
                }
            } else {
                console.warn(`WebARViewerCaptureHelper: Buffer provided with format ${this.cvData.format || 'unknown'}. Software conversion for this format is not implemented.`);
                originalFormat = `Buffer_${this.cvData.format || 'unknown'}_Raw`;
                return null; 
            }
        } else {
            console.warn('WebARViewerCaptureHelper: No usable image data (displayTexture, YCbCr textures, or buffer) found in cvData.');
            return null;
        }

        // Use reusable matrices
        this.reusableViewTransformMatrix.fromArray(this.cvData.cameraViewMatrix);
        this.reusableWorldPose.copy(this.reusableViewTransformMatrix).invert(); 
        // projectionMatrix is Float32Array from API, so no THREE.Matrix4 reuse for it.
        const projMArray = new Float32Array(cameraIntrinsicsObj.projectionMatrix);


        const intrinsics = {
            fx: cameraIntrinsicsObj.fx,
            fy: cameraIntrinsicsObj.fy,
            cx: cameraIntrinsicsObj.cx,
            cy: cameraIntrinsicsObj.cy,
            gamma: cameraIntrinsicsObj.gamma || 0, 
        };

        return {
            imageData: {
                buffer: this.rgbaBuffer,
                width: this.frameWidth,
                height: this.frameHeight,
                format: 'RGBA',
                originalFormat: originalFormat,
            },
            metadata: {
                timestamp: this.cvData.timestamp || time,
                worldPose: this.reusableWorldPose, 
                cameraIntrinsics: intrinsics,
                projectionMatrix: projMArray, 
                viewTransformMatrix: this.reusableViewTransformMatrix, 
            },
        };
    }

    destroy() {
        if (this.debug) console.log('WebARViewerCaptureHelper: Destroying...');
        // this.isCapturing = false; // Managed by BaseCaptureHelper.destroy()
        super.stopStreaming(); 

        if (this.gl && this.fb) {
            try {
                this.gl.deleteFramebuffer(this.fb);
            } catch (e) {
                console.error('WebARViewerCaptureHelper: Error deleting framebuffer:', e);
            }
        }
        this.fb = null;
        this.rgbaBuffer = null;
        this.yTexture = null;
        this.cbcrTexture = null;
        this.displayTexture = null;
        this.cvData = null;

        super.destroy(); // Calls BaseCaptureHelper's destroy for common cleanup

        if (this.debug) console.log('WebARViewerCaptureHelper: Destroyed.');
    }
}

WebARViewerCaptureHelper.prototype.usesXRFrame = true;
// WebARViewerCaptureHelper.isSupported = WebARViewerCaptureHelper.isSupported; // Not needed static inherited.
