/**
 * @fileoverview ARMarker System. Supports ARMarkers in a scene.
 * Uses the new CV pipeline (CameraImageProvider and CV Processors).
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2020, The CONIX Research Center. All rights reserved.
 * @date 2023
 */

import ARMarkerRelocalization from './armarker-reloc';
import CVWorkerMsgs from './worker-msgs'; // Still used by ARMarkerRelocalization and potentially by AprilTagProcessor for known marker messages
import { ARENA_EVENTS } from '../../constants';
import { ARENAUtils } from '../../utils';

// New CV Pipeline imports
import AprilTagProcessor from '../cv/cv-processors/apriltag-processor.js';
import OpenVPSProcessor from '../cv/cv-processors/openvps-processor.js';

const MAX_PERSISTENT_ANCHORS = 7; // From previous implementation

/**
 * ARMarker System. Supports ARMarkers in a scene.
 * @module armarker-system
 */
AFRAME.registerSystem('armarker', {
    schema: {
        /* relocalization debug messages output */
        debugRelocalization: { default: false },
        /* networked marker solver flag; let relocalization up to a networked solver;
           NOTE: at armarker init time, we look up scene options to set this flag */
        networkedLocationSolver: { default: false },
        /* how often we update markers from ATLAS; 0=never */
        ATLASUpdateIntervalSecs: { default: 30 },
        /* how often we tigger a device location update; 0=never */
        devLocUpdateIntervalSecs: { default: 0 },
        // TODO: Consider if a specific debug flag for AprilTagProcessor is needed,
        // or if debugRelocalization can be reused.
    },
    // ar markers in the scene
    markers: {},
    // ar markers retrieved from ATLAS
    ATLASMarkers: {},

    // New CV Pipeline properties
    cameraImageProviderSystem: null,
    provider: null, // Instance of CameraImageProvider
    aprilTagProcessor: null,
    openVPSProcessor: null,
    relocalizer: null,
    cameraRigObj3D: null,
    cameraSpinnerObj3D: null,
    arena: null, // Reference to ARENA system

    // Shared properties (some from previous implementation)
    webXRSession: null,
    xrRefSpace: null, // Still needed for XRFrame poses and anchor creation
    detectionEvts: new EventTarget(), // Used by ARMarkerRelocalization
    originMatrix: new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1),
    isWebXRViewer: ARENAUtils.isWebXRViewer(), // Still relevant for some logic
    initialLocalized: false, // Managed by relocalization logic
    originAnchor: undefined,
    pendingOriginAnchor: undefined,

    init() {
        ARENA.events.addMultiEventListener(
            [ARENA_EVENTS.ARENA_LOADED, ARENA_EVENTS.SCENE_OPT_LOADED],
            this.ready.bind(this)
        );

        // Bind provider event listeners
        this._onProviderInitialized = this._onProviderInitialized.bind(this);
        this._onProviderFailed = this._onProviderFailed.bind(this);
        this.el.sceneEl.addEventListener('camera-provider-initialized', this._onProviderInitialized);
        this.el.sceneEl.addEventListener('camera-provider-failed', this._onProviderFailed);
    },

    ready() {
        const { el } = this;
        const { sceneEl } = el;

        this.arena = sceneEl.systems['arena-scene'];
        this.cameraImageProviderSystem = sceneEl.systems['camera-image-provider'];

        this.cameraRigObj3D = document.getElementById('cameraRig')?.object3D;
        this.cameraSpinnerObj3D = document.getElementById('cameraSpinner')?.object3D;

        if (!this.cameraRigObj3D || !this.cameraSpinnerObj3D) {
            console.warn('ARMarker System: cameraRig or cameraSpinner Object3D not found. Relocalization may fail.');
        }

        this.data.networkedLocationSolver = !!this.arena.networkedLocationSolver;

        // Request camera access features (similar to old implementation, may need review with new CV pipeline)
        if (!ARENA.params.camFollow) { // camFollow implies no local CV processing
            const webxrSysData = sceneEl.systems.webxr?.data;
            if (webxrSysData) {
                const { optionalFeatures } = webxrSysData;
                if (this.isWebXRViewer) {
                    if (!optionalFeatures.includes('computerVision')) optionalFeatures.push('computerVision');
                } else {
                    if (!optionalFeatures.includes('camera-access')) optionalFeatures.push('camera-access');
                }
                // No direct way to setAttribute on system data, this might be handled by A-Frame WebXR system updates.
                // Forcing it like this might be brittle:
                // sceneEl.systems.webxr.sceneEl.setAttribute('webxr', 'optionalFeatures', optionalFeatures.join(', '));
                // It's better if CameraImageProvider handles any necessary feature requests via its helpers.
            } else {
                console.warn('ARMarker System: WebXR system not found, cannot set optionalFeatures for camera access.');
            }
        }

        // Listener for AR session start (mostly for WebXR session-specific setup like anchors)
        if (sceneEl.hasWebXR && navigator.xr && navigator.xr.addEventListener) {
            sceneEl.renderer.xr.addEventListener('sessionstart', () => {
                if (sceneEl.is('ar-mode')) {
                    const { xrSession } = sceneEl;
                    this.webXRSessionStarted(xrSession).then(() => {});
                }
            });
        }
        // If CameraImageProvider is already initialized (e.g. GUM started early), try initializing processors
        if (this.cameraImageProviderSystem && this.cameraImageProviderSystem.provider) {
             this._onProviderInitialized({ detail: { provider: this.cameraImageProviderSystem.provider }});
        }
    },

    _onProviderInitialized(evt) {
        if (this.provider) return; // Already initialized

        this.provider = evt.detail.provider;
        if (this.provider) {
            console.info('ARMarker System: Camera Image Provider initialized.');
            this._initializeProcessors();
        } else {
            // This case should ideally be handled by _onProviderFailed if provider is null from event
            console.error('ARMarker System: Provider initialized event received, but provider instance is null.');
            this._onProviderFailed(); // Treat as failure
        }
    },

    _onProviderFailed() {
        console.error('ARMarker System: Camera Image Provider failed to initialize. ARMarker CV features disabled.');
        this.provider = null;
    },

    _initializeProcessors() {
        if (!this.provider) {
            console.error('ARMarker System: Cannot initialize processors, Camera Image Provider is not available.');
            return;
        }

        // AprilTagProcessor Setup
        const arMarkerSysInterface = {
            getMarker: this.getMarker.bind(this),
            el: this.el,
            arena: this.arena,
            webXRSession: this.webXRSession,
            initialLocalized: this.initialLocalized, // Pass current state
            // For ARMarkerRelocalization, it needs access to cameraRig and cameraSpinner object3Ds
            // We can pass them directly or it can try to get them via document.getElementById if needed.
            // Since we have them:
            cameraRig: this.cameraRigObj3D ? { object3D: this.cameraRigObj3D } : null,
            cameraSpinner: this.cameraSpinnerObj3D ? { object3D: this.cameraSpinnerObj3D } : null,
            // ARMarkerRelocalization also uses this.originMatrix and this.setOriginAnchor
            // from the `arMakerSys` object passed to it.
            originMatrix: this.originMatrix,
            setOriginAnchor: this.setOriginAnchor.bind(this),
            // Expose detectionEvts for relocalizer to listen to
            // detectionEvts: this.detectionEvts, // This is no longer needed here, ARMarkerRelocalization takes it directly

            // Expose methods for relocalizer to update internal state like initialLocalized
            setInitialLocalized: (value) => { this.initialLocalized = value; },
        };

        this.aprilTagProcessor = new AprilTagProcessor({
            debug: this.data.debugRelocalization, // Reuse debug flag for now
            arMarkerSystemInterface: arMarkerSysInterface, // For relocalizer if instantiated inside
            enableRelocalization: true, // Assuming relocalization is key for armarker
            arenaScene: this.el.sceneEl, // Pass scene element for relocalizer
            networkedLocationSolver: this.data.networkedLocationSolver,
            debugRelocalization: this.data.debugRelocalization,
        });
        
        // Instantiate ARMarkerRelocalization here and link it
        // ARMarkerRelocalization listens to aprilTagProcessor.detectionEvents
        this.relocalizer = new ARMarkerRelocalization({
            arMakerSys: arMarkerSysInterface, // Pass the interface
            detectionsEventTarget: this.aprilTagProcessor.detectionEvents, // Listen to events from AprilTagProcessor
            networkedLocationSolver: this.data.networkedLocationSolver,
            debug: this.data.debugRelocalization,
        });

        this.provider.registerProcessor(this.aprilTagProcessor);
        console.info('ARMarker System: AprilTagProcessor registered.');

        Object.values(this.markers).forEach(markerComponent => {
            if (markerComponent.data.markertype === 'apriltag_36h11') {
                this.aprilTagProcessor.addKnownMarker(markerComponent.data.markerid, markerComponent.data.size);
            }
        });

        // OpenVPSProcessor Setup (Conditional)
        const openvpsComponent = this.el.sceneEl.components.openvps;
        if (openvpsComponent && openvpsComponent.data.enabled && openvpsComponent.data.imageUrl) {
            this.openVPSProcessor = new OpenVPSProcessor({
                imageUrl: openvpsComponent.data.imageUrl,
                interval: openvpsComponent.data.interval,
                imgQuality: openvpsComponent.data.imgQuality,
                imgType: openvpsComponent.data.imgType,
                flipHorizontal: openvpsComponent.data.flipHorizontal !== undefined ? openvpsComponent.data.flipHorizontal : false,
                flipVertical: openvpsComponent.data.flipVertical !== undefined ? openvpsComponent.data.flipVertical : false,
                debug: openvpsComponent.data.debug,
                onPoseUpdate: this._handleOpenVPSPoseUpdate.bind(this)
            });
            if (!openvpsComponent.data.confirmed) {
                this.openVPSProcessor.setEnabled(false);
            }
            this.provider.registerProcessor(this.openVPSProcessor);
            console.info('ARMarker System: OpenVPSProcessor registered.');
        } else {
            if (openvpsComponent && openvpsComponent.data.enabled && !openvpsComponent.data.imageUrl) {
                console.warn('ARMarker System: OpenVPS component enabled but imageUrl is missing. OpenVPSProcessor not started.');
            }
        }
        ARENA.events.emit(ARENA_EVENTS.CV_INITIALIZED); // Emit event after processors are set up
    },

    _handleOpenVPSPoseUpdate(newRigMatrix, confidence) {
        if (this.cameraRigObj3D && this.cameraSpinnerObj3D) {
            this.cameraRigObj3D.position.setFromMatrixPosition(newRigMatrix);
            //Spinner rotation is relative to rig, OpenVPS provides world pose for rig
            //So, effectively spinner rotation is identity relative to rig after OpenVPS update
            //This means we set spinner's world rotation to the rotation part of newRigMatrix
            this.cameraSpinnerObj3D.setRotationFromMatrix(newRigMatrix); 

            if (this.data.debugRelocalization) {
                console.log(`ARMarker: OpenVPS Pose Updated. Confidence: ${confidence}. Rig position:`, this.cameraRigObj3D.position);
            }
            
            this.initialLocalized = true; // OpenVPS provides an absolute pose

            const { xrSession } = this.el.sceneEl;
            if (xrSession && this.xrRefSpace) { // Ensure xrRefSpace is also available
                xrSession.requestAnimationFrame((time, frame) => {
                    // Use current rig and spinner pose for the anchor
                    const currentPosition = this.cameraRigObj3D.position;
                    const currentQuaternion = this.cameraSpinnerObj3D.quaternion; // World quaternion of spinner

                    this.setOriginAnchor(
                        { position: { ...currentPosition }, rotation: { ...currentQuaternion } },
                        frame
                    );
                });
            }
        } else {
            console.warn('ARMarker System: cameraRig or cameraSpinner Object3D not found for OpenVPS pose update.');
        }
    },

    async webXRSessionStarted(xrSession) {
        if (xrSession !== undefined) {
            this.webXRSession = xrSession;
            // this.gl = this.el.renderer.getContext(); // GL context is now obtained by CameraImageProvider if needed
            // No longer need to call makeXRCompatible here, provider/helpers handle it.

            this.xrRefSpace = AFRAME.scenes[0].renderer.xr.getReferenceSpace();

            // Anchor management logic remains
            const persistedOriginAnchor = window.localStorage.getItem('originAnchor');
            if (xrSession.persistentAnchors && persistedOriginAnchor && this.xrRefSpace) {
                xrSession
                    .restorePersistentAnchor(persistedOriginAnchor)
                    .then((anchor) => {
                        this.originAnchor = anchor;
                        xrSession.requestAnimationFrame((time, frame) => {
                            const originPose = frame.getPose(anchor.anchorSpace, this.xrRefSpace);
                            if (originPose && this.cameraRigObj3D && this.cameraSpinnerObj3D) {
                                const {
                                    transform: { position, orientation },
                                } = originPose;
                                const orientationQuat = new THREE.Quaternion(
                                    orientation.x, orientation.y, orientation.z, orientation.w
                                );
                                this.cameraRigObj3D.position.copy(position);
                                this.cameraSpinnerObj3D.rotation.setFromQuaternion(orientationQuat);
                            }
                        });
                    })
                    .catch(() => {
                        console.warn('Could not restore persisted origin anchor');
                        if (xrSession.persistentAnchors) { // Check again as it might be nullified
                            xrSession.persistentAnchors.forEach(async (anchorUUID) => { // Iterate over UUIDs
                                try {
                                    await xrSession.deletePersistentAnchor(anchorUUID);
                                } catch (err) {
                                    console.warn('Could not delete persisted anchor by UUID', err);
                                }
                            });
                        }
                        window.localStorage.removeItem('originAnchor');
                    });
            } else {
                window.localStorage.removeItem('originAnchor');
            }
        }
        // Old: if (!ARENA.params.camFollow) { this.initCVPipeline(); }
        // New: CV pipeline (provider & processors) should initialize independently based on camera-provider-initialized
        // or if GUM starts early. If provider is already up, _initializeProcessors might be called from ready().
    },

    update(oldData) {
        // Handle changes to system data if necessary, e.g., debug flags
        if (this.data.debugRelocalization !== oldData.debugRelocalization) {
            if (this.aprilTagProcessor) this.aprilTagProcessor.options.debug = this.data.debugRelocalization;
            if (this.relocalizer) this.relocalizer.debug = this.data.debugRelocalization;
            if (this.openVPSProcessor) this.openVPSProcessor.options.debug = this.data.debugRelocalization;
        }
        if (this.data.networkedLocationSolver !== oldData.networkedLocationSolver) {
            if (this.relocalizer) this.relocalizer.networkedLocationSolver = this.data.networkedLocationSolver;
             if (this.aprilTagProcessor && this.aprilTagProcessor.options.enableRelocalization) {
                // If relocalizer is inside AprilTagProcessor, update its option
                // This part depends on how AprilTagProcessor exposes relocalizer's options.
                // For now, assuming direct update to relocalizer is sufficient.
            }
        }
    },

    async getARMArkersFromATLAS(init = false) {
        // This method remains largely the same, as it's about marker data, not CV processing.
        // Ensure it doesn't conflict with new CV flow.
        if (!window.ARENA) return false;
        const { ARENA } = window;

        if (init) {
            this.lastATLASUpdate = new Date();
            this.lastdevLocUpdate = new Date();
        }

        if (this.data.devLocUpdateIntervalSecs > 0) {
            const now = new Date();
            if (now - this.lastdevLocUpdate >= this.data.devLocUpdateIntervalSecs * 1000) {
                ARENAUtils.getLocation((coords, err) => {
                    if (!err) ARENA.clientCoords = coords;
                    this.lastdevLocUpdate = now; // Update time after attempt
                });
            }
        }
        if (ARENA.clientCoords === undefined) {
            console.warn('No device location! Cannot query ATLAS.');
            return false;
        }
        const position = ARENA.clientCoords;

        if (this.data.ATLASUpdateIntervalSecs === 0 && !init) return false;
        const now = new Date();
        if (now - this.lastATLASUpdate < this.data.ATLASUpdateIntervalSecs * 1000) {
            return false;
        }
        
        try {
            const response = await fetch(
                `${ARENA.ATLASurl}/lookup/geo?objectType=apriltag&distance=20&units=km&lat=${position.latitude}&long=${position.longitude}`
            );
            this.lastATLASUpdate = new Date(); // Update time after fetch attempt
            if (!response.ok) {
                console.warn(`Error retrieving ATLAS markers: ${response.status}`);
                return false;
            }
            const data = await response.json();
            data.forEach((tag) => {
                const tagid = tag.name.substring(9); // Assumes "apriltag_" prefix
                if (tagid !== "0") { // Marker ID 0 is reserved for origin
                    if (tag.pose && Array.isArray(tag.pose)) {
                        const tagMatrix = new THREE.Matrix4();
                        tagMatrix.fromArray(tag.pose.flat());
                        tagMatrix.transpose();
                        this.ATLASMarkers[tagid] = {
                            id: tagid,
                            uuid: tag.id,
                            pose: tagMatrix,
                        };
                    }
                }
            });
            return true;
        } catch (error) {
            console.warn('Error during ATLAS fetch or processing:', error);
            this.lastATLASUpdate = new Date(); // Still update time to prevent spamming on error
            return false;
        }
    },

    registerComponent(marker) {
        this.markers[marker.data.markerid] = marker;
        if (this.aprilTagProcessor && marker.data.markertype === 'apriltag_36h11') {
            this.aprilTagProcessor.addKnownMarker(marker.data.markerid, marker.data.size);
        }
    },

    unregisterComponent(marker) {
        if (this.aprilTagProcessor && marker.data.markertype === 'apriltag_36h11') {
            this.aprilTagProcessor.removeKnownMarker(marker.data.markerid);
        }
        delete this.markers[marker.data.markerid];
    },

    getAll(mtype = undefined) {
        // This method remains the same.
        if (mtype === undefined) return this.markers;
        return Object.assign(
            {},
            ...Object.entries(this.markers)
                .filter(([, v]) => v.data.markertype === mtype)
                .map(([k, v]) => ({ [k]: v }))
        );
    },

    getMarker(markerid) {
        // This method remains largely the same.
        if (!(typeof markerid === 'string' || markerid instanceof String)) {
            markerid = String(markerid);
        }
        const sceneTag = this.markers[markerid];
        if (sceneTag !== undefined) {
            const markerPose = sceneTag.el.object3D.matrixWorld;
            const pos = new THREE.Vector3();
            const quat = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            markerPose.decompose(pos, quat, scale);
            const markerPoseNoScale = new THREE.Matrix4();
            markerPoseNoScale.makeRotationFromQuaternion(quat);
            markerPoseNoScale.setPosition(pos);
            return { ...sceneTag.data, obj_id: sceneTag.el.id, pose: markerPoseNoScale };
        }
        if (markerid === '0') {
            return {
                id: String(markerid),
                uuid: 'ORIGIN',
                pose: this.originMatrix,
                dynamic: false,
                buildable: false,
            };
        }
        // ATLAS query logic can remain, but should be less frequent if local CV is robust
        // Consider if getARMArkersFromATLAS should be called here if marker not found.
        // For now, it's a passive lookup.
        return this.ATLASMarkers[String(markerid)];
    },

    setOriginAnchor({ position, rotation }, xrFrame) {
        // This method remains largely the same.
        if (!this.webXRSession || !this.xrRefSpace) {
            return;
        }
        if (!xrFrame) {
            console.error("No XRFrame available, can't set origin anchor");
            return;
        }
        const anchorPose = new XRRigidTransform(position, rotation);
        xrFrame.createAnchor(anchorPose, this.xrRefSpace).then(async (anchor) => {
            if (anchor.requestPersistentHandle && this.webXRSession.persistentAnchors) {
                const oldPersistAnchor = window.localStorage.getItem('originAnchor');
                if (oldPersistAnchor) {
                    try { await this.webXRSession.deletePersistentAnchor(oldPersistAnchor); }
                    catch(e) { console.warn("Could not delete old persistent anchor", e); }
                }
                if (this.webXRSession.persistentAnchors.length >= MAX_PERSISTENT_ANCHORS) {
                    const oldestAnchor = this.webXRSession.persistentAnchors.values().next().value;
                    if (oldestAnchor) {
                         try { await this.webXRSession.deletePersistentAnchor(oldestAnchor); }
                         catch(e) { console.warn("Could not delete oldest persistent anchor", e); }
                    }
                }
                try {
                    const handle = await anchor.requestPersistentHandle();
                    window.localStorage.setItem('originAnchor', handle);
                } catch (err) {
                    console.error('Could not persist anchor', err);
                }
            } else if (this.originAnchor && typeof this.originAnchor.delete === 'function') {
                this.originAnchor.delete();
            }
            this.originAnchor = anchor;
            this.pendingOriginAnchor = false;
        }).catch(err => {
            console.error("Error creating anchor in setOriginAnchor:", err);
        });
    },

    remove() {
        // Clean up new CV pipeline components
        if (this.provider) {
            if (this.aprilTagProcessor) this.provider.unregisterProcessor(this.aprilTagProcessor);
            if (this.openVPSProcessor) this.provider.unregisterProcessor(this.openVPSProcessor);
        }
        if (this.aprilTagProcessor) {
            this.aprilTagProcessor.destroy();
            this.aprilTagProcessor = null;
        }
        if (this.openVPSProcessor) {
            this.openVPSProcessor.destroy();
            this.openVPSProcessor = null;
        }
        if (this.relocalizer && typeof this.relocalizer.destroy === 'function') {
            // this.relocalizer.destroy(); // ARMarkerRelocalization doesn't have destroy
        }
        this.relocalizer = null;
        this.provider = null; // Dereference

        // Remove event listeners
        this.el.sceneEl.removeEventListener('camera-provider-initialized', this._onProviderInitialized);
        this.el.sceneEl.removeEventListener('camera-provider-failed', this._onProviderFailed);

        // Other cleanups from old implementation if necessary
        this.markers = {};
        this.ATLASMarkers = {};
        if (this.originAnchor && typeof this.originAnchor.delete === 'function') {
            this.originAnchor.delete();
            this.originAnchor = null;
        }
    }
});
