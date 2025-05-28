/**
 * @fileoverview Base class/interface for camera capture helpers.
 *
 * This file defines the common structure and methods that all camera capture
 * helpers should implement. This ensures a consistent API for the CV system
 * to interact with different camera sources (WebXR Raw Camera, WebARViewer, getUserMedia).
 */

/**
 * Represents the image data captured by a helper.
 * @typedef {Object} CaptureImageData
 * @property {Uint8ClampedArray} buffer - The raw pixel data, typically in RGBA format.
 * @property {number} width - The width of the image in pixels.
 * @property {number} height - The height of the image in pixels.
 * @property {string} format - The format of the pixel data in the buffer (e.g., 'RGBA', 'GRAYSCALE').
 *                              Capture helpers should aim to provide 'RGBA' data.
 * @property {string} originalFormat - A string indicating the original format of the image data from
 *                                    the source API (e.g., 'WebGLTexture', 'HTMLVideoElement', 
 *                                    'WebARViewer_DisplayTexture', 'WebARViewer_NV21Buffer').
 * @property {HTMLCanvasElement} [canvas] - Optional. If the image data is readily available on an
 *                                          HTMLCanvasElement that might be useful for certain
 *                                          processors, a helper can include it.
 */

/**
 * Represents the metadata associated with a captured camera frame.
 * @typedef {Object} CaptureMetadata
 * @property {DOMHighResTimeStamp} timestamp - The timestamp (e.g., from `performance.now()` or `XRFrame.time`)
 *                                           associated with the frame capture.
 * @property {THREE.Matrix4} worldPose - The world transform matrix of the camera at the time of capture.
 *                                       Represents the camera's position and orientation in world space.
 * @property {Object|null} cameraIntrinsics - Object containing camera intrinsic parameters. Null if not available
 *                                            (e.g., for some GetUserMedia setups).
 * @property {number} cameraIntrinsics.fx - Focal length in the x-axis (pixels).
 * @property {number} cameraIntrinsics.fy - Focal length in the y-axis (pixels).
 * @property {number} cameraIntrinsics.cx - Principal point x-coordinate (pixels).
 * @property {number} cameraIntrinsics.cy - Principal point y-coordinate (pixels).
 * @property {number} [cameraIntrinsics.gamma] - Skew factor, often 0.
 * @property {Float32Array|THREE.Matrix4} projectionMatrix - The projection matrix of the camera. This could be a
 *                                                            Float32Array (e.g., from WebXR view.projectionMatrix)
 *                                                            or a THREE.Matrix4 object.
 * @property {THREE.Matrix4} viewTransformMatrix - The view transform matrix of the camera. This is typically
 *                                                 the inverse of `worldPose`.
 * @property {string} [facingMode] - Optional. For GetUserMedia sourced images, this indicates the facing mode
 *                                   of the camera used (e.g., 'user', 'environment').
 */

/**
 * The object returned by a Capture Helper's `getFrameData` method.
 * @typedef {Object} FrameData
 * @property {CaptureImageData|null} imageData - The captured image data. Null if no image was
 *                                               available or an error occurred.
 * @property {CaptureMetadata|null} metadata - The metadata associated with the captured frame. Null if
 *                                            unavailable or an error occurred.
 */

// Note: THREE.Matrix4 is used in the JSDocs above. It's assumed to be available globally,
// often exposed by AFRAME (e.g., AFRAME.THREE.Matrix4). If not, an explicit import
// or different type reference might be needed depending on the project setup.

export default class BaseCaptureHelper {
    /**
     * Constructor for the capture helper.
     * @param {XRSession} [xrSession=null] - The active WebXR session, if applicable.
     * @param {WebGLRenderingContext} [glContext=null] - The WebGL rendering context, if applicable.
     * @param {HTMLElement} [aframeCameraEl=null] - The A-Frame camera entity, used for pose information with GUM.
     * @param {object} [options={}] - Additional options for the helper.
     */
    constructor(xrSession = null, glContext = null, aframeCameraEl = null, options = {}) {
        this.xrSession = xrSession;
        this.gl = glContext;
        this.aframeCameraEl = aframeCameraEl;
        this.options = options;
        this.isCapturing = false; // Indicates if capture is active
    }

    /**
     * Checks if the underlying API for this helper is available and supported by the browser.
     * This method should be overridden by subclasses.
     * @param {XRSession} [xrSession=null] - The active WebXR session, if applicable.
     * @param {WebGLRenderingContext} [glContext=null] - The WebGL rendering context, if applicable.
     * @returns {boolean} True if supported, false otherwise.
     */
    static isSupported(xrSession = null, glContext = null) {
        // This should be implemented by subclasses
        return false;
    }

    /**
     * Initializes the camera access and prepares for frame capture.
     * This method should be overridden by subclasses.
     * @returns {Promise<boolean>|boolean} A promise that resolves to true on success, false on failure, or a boolean directly.
     */
    async init() {
        // This should be implemented by subclasses
        return false;
    }

    /**
     * Acquires and returns frame data from the camera.
     * This method should be overridden by subclasses.
     * @param {DOMHighResTimeStamp} time - The current time.
     * @param {XRFrame} [frame=null] - The XRFrame object, for WebXR-based helpers.
     * @param {XRPose} [pose=null] - The XRPose object, for WebXR-based helpers.
     * @returns {Promise<FrameData|null>} A promise that resolves to a FrameData object
     *                                    or null if no frame is available or an error occurs.
     */
    async getFrameData(time, frame = null, pose = null) {
        // This should be implemented by subclasses
        return null;
    }

    /**
     * Starts the video stream.
     * Base implementation sets a flag. Subclasses may override for specific start logic.
     * This method is called by CameraImageProvider when starting the capture loop.
     */
    startStreaming() {
        this.isStreaming = true; // Renamed from isCapturing to avoid conflict with init status
                                 // isCapturing (from constructor) means helper is ready/initialized.
                                 // isStreaming means it's actively trying to provide frames.
    }

    /**
     * Stops the video stream.
     * Base implementation sets a flag. Subclasses may override for specific stop logic.
     * This method is called by CameraImageProvider when stopping the capture loop.
     */
    stopStreaming() {
        this.isStreaming = false;
    }

    /**
     * Cleans up resources used by the helper (e.g., stop video tracks, delete WebGL objects).
     * This method should be overridden by subclasses.
     */
    destroy() {
        this.isCapturing = false; // Mark as no longer initialized
        this.isStreaming = false; // Ensure streaming is also marked as stopped
        // Subclasses should clean up their specific resources (video elements, GL objects, etc.)
        // and nullify references (xrSession, gl, aframeCameraEl)
        this.xrSession = null;
        this.gl = null;
        this.aframeCameraEl = null;
        this.options = {};
    }
}

/**
 * Indicates whether the helper relies on the XR session's requestAnimationFrame loop.
 * Helpers that use `XRFrame` will set this to true. GUM helpers will typically set this to false.
 * @type {boolean}
 */
BaseCaptureHelper.prototype.usesXRFrame = false;
