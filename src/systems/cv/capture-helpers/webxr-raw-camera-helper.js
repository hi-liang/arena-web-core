// Investigation of src/systems/armarker/camera-capture/ccwebxr.js:
// - Raw image format: WebGLTexture obtained via XRWebGLBinding.getCameraImage(view.camera).
// - Processing:
//   - Texture is bound to a framebuffer (this.fb).
//   - Pixels are read from the framebuffer into a Uint8ClampedArray (this.framePixels) using gl.readPixels.
//     The format read is RGBA.
//   - A grayscale version (this.frameGsPixels) is derived from this.framePixels by taking the green channel (this.framePixels[i+1]).
//   - Image is vertically flipped during the grayscale conversion loop.
//   - Debug mode: Draws detected corners onto this.framePixels (RGBA) and then uses it to create a THREE.DataTexture for display on a plane.
// - Data to CV Worker: Message with { type: CVWorkerMsgs.type.PROCESS_GSFRAME, ts, width, height, grayscalePixels, camera }.
//   - `grayscalePixels` is the Uint8ClampedArray containing the derived grayscale image.
//   - `camera` contains intrinsics (fx, fy, cx, cy, gamma) derived from view.projectionMatrix and viewport.

import BaseCaptureHelper from './base-capture-helper.js';
// Assuming THREE is available via AFRAME's export or globally
const THREE = AFRAME.THREE;

export default class WebXRRawCameraCaptureHelper extends BaseCaptureHelper {
    constructor(xrSession, glContext, xrRefSpace, aframeCameraEl = null, options = {}) {
        super(xrSession, glContext, aframeCameraEl, options); 
        this.xrRefSpace = xrRefSpace; // Storing xrRefSpace passed from CameraImageProvider

        this.glBinding = null;
        this.fb = null; 
        this.framePixels = null; 
        this.frameWidth = 0;
        this.frameHeight = 0;
        this.frameCameraIntrinsics = null;
        // this.isCapturing = false; // Managed by BaseCaptureHelper

        // Reusable THREE.Matrix4 instances
        this.reusableWorldPose = new THREE.Matrix4();
        this.reusableViewTransformMatrix = new THREE.Matrix4(); // Will store view.transform.matrix
        this.reusableViewerMatrix = new THREE.Matrix4(); // Will store viewerPose.transform.matrix


        this.debug = options.debug || false; // Ensure options.debug is accessed via this.options if preferred after super
        if (this.debug) {
            console.info('WebXRRawCameraCaptureHelper: Debug mode enabled.');
        }
    }

    static isSupported(xrSession, glContext) {
        if (!xrSession || !glContext || !window.XRWebGLBinding) {
            return false;
        }
        try {
            const tempGlBinding = new window.XRWebGLBinding(xrSession, glContext);
            return typeof tempGlBinding.getCameraImage === 'function';
        } catch (error) {
            console.warn('WebXRRawCameraCaptureHelper.isSupported: Error checking support:', error);
            return false;
        }
    }

    async init() {
        if (this.isCapturing) { 
             if (this.debug) console.log('WebXRRawCameraCaptureHelper: Already initialized.');
             return true;
        }

        if (!this.xrSession || !this.gl) {
            console.error('WebXRRawCameraCaptureHelper: XR session or GL context not available for init.');
            return false;
        }

        try {
            this.glBinding = new window.XRWebGLBinding(this.xrSession, this.gl);
            if (!this.glBinding) {
                console.error('WebXRRawCameraCaptureHelper: Failed to create XRWebGLBinding.');
                return false;
            }
        } catch (error) {
            console.error('WebXRRawCameraCaptureHelper: Error creating XRWebGLBinding:', error);
            return false;
        }

        this.fb = this.gl.createFramebuffer();
        if (!this.fb) {
            console.error('WebXRRawCameraCaptureHelper: Failed to create WebGL framebuffer.');
            this.glBinding = null; 
            return false;
        }

        if (!this.xrRefSpace) { // This check is now more critical if pose is fetched here
            console.error('WebXRRawCameraCaptureHelper: XR reference space not provided during construction or available at init.');
             if (this.fb) this.gl.deleteFramebuffer(this.fb);
             // this.glBinding should be nulled if we are returning false from init and it was created
             if (this.glBinding) this.glBinding = null; 
             this.fb = null;
            return false;
        }

        this.isCapturing = true; 
        if (this.debug) console.log('WebXRRawCameraCaptureHelper: Initialized successfully.');
        return true;
    }

    _calculateCameraIntrinsics(projectionMatrixArray, viewport) {
        const p = projectionMatrixArray;
        if (!p || p.length < 16) {
            console.error('WebXRRawCameraCaptureHelper: Invalid projection matrix for intrinsics calculation.');
            return null;
        }
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
            console.error('WebXRRawCameraCaptureHelper: Invalid viewport for intrinsics calculation.');
            return null;
        }

        const fx = (viewport.width / 2) * p[0];  
        const fy = (viewport.height / 2) * p[5]; 
        const cx = ((1 - p[8]) * viewport.width) / 2 + (viewport.x || 0);
        const cy = ((1 - p[9]) * viewport.height) / 2 + (viewport.y || 0); 
        const gamma = (viewport.width / 2) * p[4]; 

        if (isNaN(fx) || isNaN(fy) || isNaN(cx) || isNaN(cy) || isNaN(gamma)) {
            console.error('WebXRRawCameraCaptureHelper: NaN value in calculated camera intrinsics.');
            return null;
        }
        return { fx, fy, cx, cy, gamma };
    }

    // Signature changed: pose parameter removed
    async getFrameData(time, frame) { 
        // isStreaming is set by BaseCaptureHelper's start/stopStreaming
        if (!this.isCapturing || !super.isStreaming || !this.glBinding || !frame || !this.fb) {
            if (this.debug && (!this.isCapturing || !super.isStreaming)) {
                // console.warn('WebXRRawCameraCaptureHelper: Not capturing/streaming or not properly initialized.');
            }
            return null;
        }

        if (!this.xrRefSpace) { // Moved from init to here as per instructions, though also checked in init.
            console.error('WebXRRawCameraCaptureHelper: xrRefSpace is not available.');
            return null;
        }
        const viewerPose = frame.getViewerPose(this.xrRefSpace);
        if (!viewerPose) {
            if (this.options && this.options.debug) { 
                console.warn('WebXRRawCameraCaptureHelper: No viewer pose for XR frame.');
            }
            return null;
        }

        let processedViewData = null;

        // Loop changed from pose.views to viewerPose.views
        for (const view of viewerPose.views) {
            if (!view.camera) continue;

            const xrCamera = view.camera;
            let texture;
            try {
                texture = this.glBinding.getCameraImage(xrCamera);
            } catch (error) {
                console.warn('WebXRRawCameraCaptureHelper: Error getting camera image texture:', error);
                continue; 
            }

            if (!texture) {
                // if (this.debug) console.warn('WebXRRawCameraCaptureHelper: Could not get camera image texture for view.');
                continue; 
            }

            const glLayer = this.xrSession.renderState.baseLayer;
            if (!glLayer) {
                console.warn('WebXRRawCameraCaptureHelper: No baseLayer found on XR session renderState.');
                this.gl.deleteTexture(texture); 
                return null;
            }

            if (this.frameWidth !== xrCamera.width || this.frameHeight !== xrCamera.height) {
                this.frameWidth = xrCamera.width;
                this.frameHeight = xrCamera.height;

                if (this.frameWidth <= 0 || this.frameHeight <= 0) {
                    console.warn(`WebXRRawCameraCaptureHelper: Invalid frame dimensions: ${this.frameWidth}x${this.frameHeight}.`);
                    this.gl.deleteTexture(texture);
                    return null;
                }

                this.framePixels = new Uint8ClampedArray(this.frameWidth * this.frameHeight * 4);
                this.frameCameraIntrinsics = this._calculateCameraIntrinsics(
                    view.projectionMatrix,
                    { width: this.frameWidth, height: this.frameHeight, x: 0, y: 0 }
                );

                if (!this.frameCameraIntrinsics) {
                    console.error('WebXRRawCameraCaptureHelper: Failed to calculate camera intrinsics.');
                    this.gl.deleteTexture(texture);
                    this.framePixels = null; 
                    return null;
                }
                if (this.debug) console.log(`WebXRRawCameraCaptureHelper: Frame size changed/initialized to ${this.frameWidth}x${this.frameHeight}`);
            }

            const previousFramebuffer = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fb);
            this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, texture, 0);

            const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
            if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
                console.error('WebXRRawCameraCaptureHelper: Framebuffer not complete. Status:', status);
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, previousFramebuffer); 
                this.gl.deleteTexture(texture); 
                continue; 
            }

            this.gl.readPixels(0, 0, this.frameWidth, this.frameHeight, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.framePixels);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, previousFramebuffer); 
            this.gl.deleteTexture(texture); 

            // Use viewerPose and view.transform.matrix
            this.reusableViewerMatrix.fromArray(viewerPose.transform.matrix);
            this.reusableViewTransformMatrix.fromArray(view.transform.matrix); // This is view-relative-to-viewer (viewMatrixInViewerSpace)
            this.reusableWorldPose.multiplyMatrices(this.reusableViewerMatrix, this.reusableViewTransformMatrix);


            // Fallback logic for problematic matrices
            if (!this.reusableWorldPose.elements.some(e => !isNaN(e) && Math.abs(e) > 1e-6) && 
                this.aframeCameraEl && this.aframeCameraEl.object3D) {
                 console.warn("WebXRRawCameraCaptureHelper: viewWorldMatrix from XRFrame invalid, falling back to aframeCameraEl.object3D.matrixWorld");
                 this.reusableWorldPose.copy(this.aframeCameraEl.object3D.matrixWorld);
                 this.reusableViewTransformMatrix.copy(this.reusableWorldPose).invert(); // viewTransformMatrix becomes effectively inverse of worldPose
            }


            processedViewData = {
                imageData: {
                    buffer: this.framePixels, 
                    width: this.frameWidth,
                    height: this.frameHeight,
                    format: 'RGBA', 
                    originalFormat: 'WebGLTexture',
                },
                metadata: {
                    timestamp: time,
                    worldPose: this.reusableWorldPose, 
                    cameraIntrinsics: this.frameCameraIntrinsics,
                    projectionMatrix: new Float32Array(view.projectionMatrix), 
                    viewTransformMatrix: this.reusableViewTransformMatrix, // This holds view.transform.matrix (relative to viewer)
                },
            };
            break; 
        }

        return processedViewData; 
    }

    destroy() {
        if (this.debug) console.log('WebXRRawCameraCaptureHelper: Destroying...');
        if (this.gl && this.fb) {
            try {
                this.gl.deleteFramebuffer(this.fb);
            } catch (e) {
                console.error('WebXRRawCameraCaptureHelper: Error deleting framebuffer:', e);
            }
        }
        this.fb = null;
        this.glBinding = null; 
        this.framePixels = null;
        this.frameCameraIntrinsics = null;
        
        super.destroy(); 

        if (this.debug) console.log('WebXRRawCameraCaptureHelper: Destroyed.');
    }
}

WebXRRawCameraCaptureHelper.prototype.usesXRFrame = true;
// WebXRRawCameraCaptureHelper.isSupported = WebXRRawCameraCaptureHelper.isSupported; // Not needed, static methods inherit.
