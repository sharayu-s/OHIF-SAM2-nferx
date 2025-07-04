import { utils, Types } from '@ohif/core';

import { ContextMenuController, defaultContextMenu } from './CustomizableContextMenu';
import DicomTagBrowser from './DicomTagBrowser/DicomTagBrowser';
import reuseCachedLayouts from './utils/reuseCachedLayouts';
import findViewportsByPosition, {
  findOrCreateViewport as layoutFindOrCreate,
} from './findViewportsByPosition';

import { ContextMenuProps } from './CustomizableContextMenu/types';
import { NavigateHistory } from './types/commandModuleTypes';
import { history } from '@ohif/app';
import { useViewportGridStore } from './stores/useViewportGridStore';
import { useDisplaySetSelectorStore } from './stores/useDisplaySetSelectorStore';
import { useHangingProtocolStageIndexStore } from './stores/useHangingProtocolStageIndexStore';
import { useToggleHangingProtocolStore } from './stores/useToggleHangingProtocolStore';
import { useViewportsByPositionStore } from './stores/useViewportsByPositionStore';
import { useToggleOneUpViewportGridStore } from './stores/useToggleOneUpViewportGridStore';

import { Enums as csToolsEnums } from '@cornerstonejs/tools';
import { defaultRouteInit } from '@routes/Mode/defaultRouteInit'
import MonaiLabelClient from '../../monai-label/src/services/MonaiLabelClient';
import axios from 'axios';


export type HangingProtocolParams = {
  protocolId?: string;
  stageIndex?: number;
  activeStudyUID?: string;
  stageId?: string;
  reset?: false;
};

export type UpdateViewportDisplaySetParams = {
  direction: number;
  excludeNonImageModalities?: boolean;
};

const commandsModule = ({
  servicesManager,
  commandsManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const {
    customizationService,
    measurementService,
    hangingProtocolService,
    uiNotificationService,
    viewportGridService,
    displaySetService,
  } = servicesManager.services;

  // Define a context menu controller for use with any context menus
  const contextMenuController = new ContextMenuController(servicesManager, commandsManager);

  const actions = {
    /**
     * Show the context menu.
     * @param options.menuId defines the menu name to lookup, from customizationService
     * @param options.defaultMenu contains the default menu set to use
     * @param options.element is the element to show the menu within
     * @param options.event is the event that caused the context menu
     * @param options.selectorProps is the set of selection properties to use
     */
    showContextMenu: (options: ContextMenuProps) => {
      const {
        menuCustomizationId,
        element,
        event,
        selectorProps,
        defaultPointsPosition = [],
      } = options;

      const optionsToUse = { ...options };

      if (menuCustomizationId) {
        Object.assign(
          optionsToUse,
          customizationService.get(menuCustomizationId, defaultContextMenu)
        );
      }

      // TODO - make the selectorProps richer by including the study metadata and display set.
      const { protocol, stage } = hangingProtocolService.getActiveProtocol();
      optionsToUse.selectorProps = {
        event,
        protocol,
        stage,
        ...selectorProps,
      };

      contextMenuController.showContextMenu(optionsToUse, element, defaultPointsPosition);
    },

    /** Close a context menu currently displayed */
    closeContextMenu: () => {
      contextMenuController.closeContextMenu();
    },

    displayNotification: ({ text, title, type }) => {
      uiNotificationService.show({
        title: title,
        message: text,
        type: type,
      });
    },
    clearMeasurements: () => {
      measurementService.clearMeasurements();
    },

    /**
     *  Sets the specified protocol
     *    1. Records any existing state using the viewport grid service
     *    2. Finds the destination state - this can be one of:
     *       a. The specified protocol stage
     *       b. An alternate (toggled or restored) protocol stage
     *       c. A restored custom layout
     *    3. Finds the parameters for the specified state
     *       a. Gets the displaySetSelectorMap
     *       b. Gets the map by position
     *       c. Gets any toggle mapping to map position to/from current view
     *    4. If restore, then sets layout
     *       a. Maps viewport position by currently displayed viewport map id
     *       b. Uses toggle information to map display set id
     *    5. Else applies the hanging protocol
     *       a. HP Service is provided displaySetSelectorMap
     *       b. HP Service will throw an exception if it isn't applicable
     * @param options - contains information on the HP to apply
     * @param options.activeStudyUID - the updated study to apply the HP to
     * @param options.protocolId - the protocol ID to change to
     * @param options.stageId - the stageId to apply
     * @param options.stageIndex - the index of the stage to go to.
     * @param options.reset - flag to indicate if the HP should be reset to its original and not restored to a previous state
     *
     * commandsManager.run('setHangingProtocol', {
     *   activeStudyUID: '1.2.3',
     *   protocolId: 'myProtocol',
     *   stageId: 'myStage',
     *   stageIndex: 0,
     *   reset: false,
     * });
     */
    setHangingProtocol: ({
      activeStudyUID = '',
      protocolId,
      stageId,
      stageIndex,
      reset = false,
    }: HangingProtocolParams): boolean => {
      try {
        // Stores in the state the display set selector id to displaySetUID mapping
        // Pass in viewportId for the active viewport.  This item will get set as
        // the activeViewportId
        const state = viewportGridService.getState();
        const hpInfo = hangingProtocolService.getState();
        reuseCachedLayouts(state, hangingProtocolService);
        const { hangingProtocolStageIndexMap } = useHangingProtocolStageIndexStore.getState();
        const { displaySetSelectorMap } = useDisplaySetSelectorStore.getState();

        if (!protocolId) {
          // Reuse the previous protocol id, and optionally stage
          protocolId = hpInfo.protocolId;
          if (stageId === undefined && stageIndex === undefined) {
            stageIndex = hpInfo.stageIndex;
          }
        } else if (stageIndex === undefined && stageId === undefined) {
          // Re-set the same stage as was previously used
          const hangingId = `${activeStudyUID || hpInfo.activeStudyUID}:${protocolId}`;
          stageIndex = hangingProtocolStageIndexMap[hangingId]?.stageIndex;
        }

        const useStageIdx =
          stageIndex ??
          hangingProtocolService.getStageIndex(protocolId, {
            stageId,
            stageIndex,
          });

        if (activeStudyUID) {
          hangingProtocolService.setActiveStudyUID(activeStudyUID);
        }

        const storedHanging = `${hangingProtocolService.getState().activeStudyUID}:${protocolId}:${
          useStageIdx || 0
        }`;

        const { viewportGridState } = useViewportGridStore.getState();
        const restoreProtocol = !reset && viewportGridState[storedHanging];

        if (
          protocolId === hpInfo.protocolId &&
          useStageIdx === hpInfo.stageIndex &&
          !activeStudyUID
        ) {
          // Clear the HP setting to reset them
          hangingProtocolService.setProtocol(protocolId, {
            stageId,
            stageIndex: useStageIdx,
          });
        } else {
          hangingProtocolService.setProtocol(protocolId, {
            displaySetSelectorMap,
            stageId,
            stageIndex: useStageIdx,
            restoreProtocol,
          });
          if (restoreProtocol) {
            viewportGridService.set(viewportGridState[storedHanging]);
          }
        }
        // Do this after successfully applying the update
        const { setDisplaySetSelector } = useDisplaySetSelectorStore.getState();
        setDisplaySetSelector(
          `${activeStudyUID || hpInfo.activeStudyUID}:activeDisplaySet:0`,
          null
        );
        return true;
      } catch (e) {
        console.error(e);
        uiNotificationService.show({
          title: 'Apply Hanging Protocol',
          message: 'The hanging protocol could not be applied.',
          type: 'error',
          duration: 3000,
        });
        return false;
      }
    },

    toggleHangingProtocol: ({ protocolId, stageIndex }: HangingProtocolParams): boolean => {
      const {
        protocol,
        stageIndex: desiredStageIndex,
        activeStudy,
      } = hangingProtocolService.getActiveProtocol();
      const { toggleHangingProtocol, setToggleHangingProtocol } =
        useToggleHangingProtocolStore.getState();
      const storedHanging = `${activeStudy.StudyInstanceUID}:${protocolId}:${stageIndex | 0}`;
      if (
        protocol.id === protocolId &&
        (stageIndex === undefined || stageIndex === desiredStageIndex)
      ) {
        // Toggling off - restore to previous state
        const previousState = toggleHangingProtocol[storedHanging] || {
          protocolId: 'default',
        };
        return actions.setHangingProtocol(previousState);
      } else {
        setToggleHangingProtocol(storedHanging, {
          protocolId: protocol.id,
          stageIndex: desiredStageIndex,
        });
        return actions.setHangingProtocol({
          protocolId,
          stageIndex,
          reset: true,
        });
      }
    },

    deltaStage: ({ direction }) => {
      const { protocolId, stageIndex: oldStageIndex } = hangingProtocolService.getState();
      const { protocol } = hangingProtocolService.getActiveProtocol();
      for (
        let stageIndex = oldStageIndex + direction;
        stageIndex >= 0 && stageIndex < protocol.stages.length;
        stageIndex += direction
      ) {
        if (protocol.stages[stageIndex].status !== 'disabled') {
          return actions.setHangingProtocol({
            protocolId,
            stageIndex,
          });
        }
      }
      uiNotificationService.show({
        title: 'Change Stage',
        message: 'The hanging protocol has no more applicable stages',
        type: 'info',
        duration: 3000,
      });
    },

    /**
     * Changes the viewport grid layout in terms of the MxN layout.
     */
    setViewportGridLayout: ({ numRows, numCols, isHangingProtocolLayout = false }) => {
      const { protocol } = hangingProtocolService.getActiveProtocol();
      const onLayoutChange = protocol.callbacks?.onLayoutChange;
      if (commandsManager.run(onLayoutChange, { numRows, numCols }) === false) {
        console.log('setViewportGridLayout running', onLayoutChange, numRows, numCols);
        // Don't apply the layout if the run command returns false
        return;
      }

      const completeLayout = () => {
        const state = viewportGridService.getState();
        findViewportsByPosition(state, { numRows, numCols });

        const { viewportsByPosition, initialInDisplay } = useViewportsByPositionStore.getState();

        const findOrCreateViewport = layoutFindOrCreate.bind(
          null,
          hangingProtocolService,
          isHangingProtocolLayout,
          { ...viewportsByPosition, initialInDisplay }
        );

        viewportGridService.setLayout({
          numRows,
          numCols,
          findOrCreateViewport,
          isHangingProtocolLayout,
        });
      };
      // Need to finish any work in the callback
      window.setTimeout(completeLayout, 0);
    },

    toggleOneUp() {
      const viewportGridState = viewportGridService.getState();
      const { activeViewportId, viewports, layout, isHangingProtocolLayout } = viewportGridState;
      const { displaySetInstanceUIDs, displaySetOptions, viewportOptions } =
        viewports.get(activeViewportId);

      if (layout.numCols === 1 && layout.numRows === 1) {
        // The viewer is in one-up. Check if there is a state to restore/toggle back to.
        const { toggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();

        if (!toggleOneUpViewportGridStore) {
          return;
        }
        // There is a state to toggle back to. The viewport that was
        // originally toggled to one up was the former active viewport.
        const viewportIdToUpdate = toggleOneUpViewportGridStore.activeViewportId;

        // We are restoring the previous layout but taking into the account that
        // the current one up viewport might have a new displaySet dragged and dropped on it.
        // updatedViewportsViaHP below contains the viewports applicable to the HP that existed
        // prior to the toggle to one-up - including the updated viewports if a display
        // set swap were to have occurred.
        const updatedViewportsViaHP =
          displaySetInstanceUIDs.length > 1
            ? []
            : displaySetInstanceUIDs
                .map(displaySetInstanceUID =>
                  hangingProtocolService.getViewportsRequireUpdate(
                    viewportIdToUpdate,
                    displaySetInstanceUID,
                    isHangingProtocolLayout
                  )
                )
                .flat();

        // findOrCreateViewport returns either one of the updatedViewportsViaHP
        // returned from the HP service OR if there is not one from the HP service then
        // simply returns what was in the previous state for a given position in the layout.
        const findOrCreateViewport = (position: number, positionId: string) => {
          // Find the viewport for the given position prior to the toggle to one-up.
          const preOneUpViewport = Array.from(toggleOneUpViewportGridStore.viewports.values()).find(
            viewport => viewport.positionId === positionId
          );

          // Use the viewport id from before the toggle to one-up to find any updates to the viewport.
          const viewport = updatedViewportsViaHP.find(
            viewport => viewport.viewportId === preOneUpViewport.viewportId
          );

          return viewport
            ? // Use the applicable viewport from the HP updated viewports
              { viewportOptions, displaySetOptions, ...viewport }
            : // Use the previous viewport for the given position
              preOneUpViewport;
        };

        const layoutOptions = viewportGridService.getLayoutOptionsFromState(
          toggleOneUpViewportGridStore
        );

        // Restore the previous layout including the active viewport.
        viewportGridService.setLayout({
          numRows: toggleOneUpViewportGridStore.layout.numRows,
          numCols: toggleOneUpViewportGridStore.layout.numCols,
          activeViewportId: viewportIdToUpdate,
          layoutOptions,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });

        // Reset crosshairs after restoring the layout
        setTimeout(() => {
          commandsManager.runCommand('resetCrosshairs');
        }, 0);
      } else {
        // We are not in one-up, so toggle to one up.

        // Store the current viewport grid state so we can toggle it back later.
        const { setToggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();
        setToggleOneUpViewportGridStore(viewportGridState);

        // one being toggled to one up.
        const findOrCreateViewport = () => {
          return {
            displaySetInstanceUIDs,
            displaySetOptions,
            viewportOptions,
          };
        };

        // Set the layout to be 1x1/one-up.
        viewportGridService.setLayout({
          numRows: 1,
          numCols: 1,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });
      }
    },

    /**
     * Exposes the browser history navigation used by OHIF. This command can be used to either replace or
     * push a new entry into the browser history. For example, the following will replace the current
     * browser history entry with the specified relative URL which changes the study displayed to the
     * study with study instance UID 1.2.3. Note that as a result of using `options.replace = true`, the
     * page prior to invoking this command cannot be returned to via the browser back button.
     *
     * navigateHistory({
     *   to: 'viewer?StudyInstanceUIDs=1.2.3',
     *   options: { replace: true },
     * });
     *
     * @param historyArgs - arguments for the history function;
     *                      the `to` property is the URL;
     *                      the `options.replace` is a boolean indicating if the current browser history entry
     *                      should be replaced or a new entry pushed onto the history (stack); the default value
     *                      for `replace` is false
     */
    navigateHistory(historyArgs: NavigateHistory) {
      history.navigate(historyArgs.to, historyArgs.options);
    },

    openDICOMTagViewer({ displaySetInstanceUID }: { displaySetInstanceUID?: string }) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;
      const { UIModalService } = servicesManager.services;

      const defaultDisplaySetInstanceUID = displaySetInstanceUID || displaySetInstanceUIDs[0];
      UIModalService.show({
        content: DicomTagBrowser,
        contentProps: {
          displaySets,
          displaySetInstanceUID: defaultDisplaySetInstanceUID,
          onClose: UIModalService.hide,
        },
        containerDimensions: 'w-[70%] max-w-[900px]',
        title: 'DICOM Tag Browser',
      });
    },

    async sam2_one() {
      const response = await MonaiLabelClient.api_get('/monai/info/');
      if (response.status === 200) {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'Connecting to MONAI Label',
          type: 'info',
          duration: 3000,
        });
      } else {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'Failed to connect to MONAI Label',
          type: 'error',
          duration: 3000,
        });
        return response;
      }
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;
      //const { UIModalService } = servicesManager.services;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];

      //const prompts = Array.from(measurementService.measurements).filter((e)=>{return e[1].data!==undefined}).map((e)=>{return Object.values(e[1].data)[0].index})
      const pos_points = Array.from(measurementService.measurements)
        .filter(e => {
          return e[1].toolName === 'Probe';
        })
        .map(e => {
          return Object.values(e[1].data)[0].index;
        });
      const neg_points = Array.from(measurementService.measurements)
        .filter(e => {
          return e[1].toolName === 'Probe2';
        })
        .map(e => {
          return Object.values(e[1].data)[0].index;
        });
      const bd_boxes = Array.from(measurementService.measurements)
        .filter(e => { return e[1].toolName === 'RectangleROI2' })
        .map(e => { return Object.values(e[1].data)[0].pointsInShape })

      let box_prompts = bd_boxes.map(e => { return [e.at(0).pointIJK, e.at(-1).pointIJK] })

      const text_prompts = Array.from(services.measurementService.measurements)
      .filter(e => { return e[1].toolName === 'Probe' })
      .map(e => { return e[1].label })

      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        device: response.data.trainers.segmentation.config.device,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        boxes: box_prompts,
        texts: text_prompts,
        one: true,
      };

      if(useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj!==undefined){
        params.nextObj = useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj
      }

      let data = MonaiLabelClient.constructFormData(params, null);

      axios
        .post(url, data, {
          responseType: 'arraybuffer',
          headers: {
            accept: 'application/json, multipart/form-data',
          },
        })
        .then(function (response) {
          console.debug(response);
          if (response.status === 200) {
            uiNotificationService.show({
              title: 'MONAI Label',
              message: 'Run Segmentation - Successful',
              type: 'success',
              duration: 2000,
            });
            let currentDate = utils.formatDate(Date.now(), 'YYYYMMDD')
            //old segementation is deleted at PACS, should be excluded from activeDisplaySets
            displaySetService.activeDisplaySets = displaySetService.activeDisplaySets.filter(e => {
              return (e.SeriesDescription != 'SAM2_' + currentDisplaySets.SeriesDescription) || (e.SeriesDate != currentDate);
            })

            let studyInstanceUID = currentDisplaySets.StudyInstanceUID
            let studyInstanceUIDs = [studyInstanceUID, 1]
            let dataSource = extensionManager.getActiveDataSource()[0]
            let filters = { 'StudyInstanceUIDs': [studyInstanceUID] }
            let appConfig = config
            let unsubscriptions = defaultRouteInit({ servicesManager, studyInstanceUIDs, dataSource, filters, appConfig }, "default", 0).then(async function (unsub) {
              const displaySets = displaySetService.activeDisplaySets;
              const currentDisplaySet = displaySets.filter(e => {
                return (e.SeriesDescription == 'SAM2_' + currentDisplaySets.SeriesDescription) && (e.SeriesDate == currentDate);
              })[0];
              let updatedViewports = hangingProtocolService.getViewportsRequireUpdate(activeViewportId, currentDisplaySet.displaySetInstanceUID, true)
              viewportGridService.setDisplaySetsForViewports(updatedViewports)
            })
          }
          return response;
        })
        .catch(function (error) {
          return error;
        })
        .finally(function () { });
    },
    async sam2() {
      const response = await MonaiLabelClient.api_get('/monai/info/');
      if (response.status === 200) {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'Connecting to MONAI Label',
          type: 'info',
          duration: 3000,
        });
      } else {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'Failed to connect to MONAI Label',
          type: 'error',
          duration: 3000,
        });
        return response;
      }
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;
      //const { UIModalService } = servicesManager.services;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];

      //const prompts = Array.from(measurementService.measurements).filter((e)=>{return e[1].data!==undefined}).map((e)=>{return Object.values(e[1].data)[0].index})
      const pos_points = Array.from(measurementService.measurements)
        .filter(e => {
          return e[1].toolName === 'Probe';
        })
        .map(e => {
          return Object.values(e[1].data)[0].index;
        });
      const neg_points = Array.from(measurementService.measurements)
        .filter(e => {
          return e[1].toolName === 'Probe2';
        })
        .map(e => {
          return Object.values(e[1].data)[0].index;
        });

      const bd_boxes = Array.from(measurementService.measurements)
        .filter(e => { return e[1].toolName === 'RectangleROI2' })
        .map(e => { return Object.values(e[1].data)[0].pointsInShape })

      let box_prompts = bd_boxes.map(e => { return [e.at(0).pointIJK, e.at(-1).pointIJK] })

      const text_prompts = Array.from(services.measurementService.measurements)
      .filter(e => { return e[1].toolName === 'Probe' })
      .map(e => { return e[1].label })

      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        device: response.data.trainers.segmentation.config.device,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        boxes: box_prompts,
        texts: text_prompts
      };

      if(useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj!==undefined){
        params.nextObj = useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj
      }

      let data = MonaiLabelClient.constructFormData(params, null);

      axios
        .post(url, data, {
          responseType: 'arraybuffer',
          headers: {
            accept: 'application/json, multipart/form-data',
          },
        })
        .then(function (response) {
          console.log('🟡 SAM2 command - Response received:', response);
          console.log('🟡 Response status:', response.status);
          console.log('🟡 Response headers:', response.headers);
          console.debug(response);
          
          if (response.status === 200) {
            // Check if this is an ultrasound file download response
            const isUltrasoundDownload = response.headers && (
              response.headers['x-modality'] === 'ultrasound' ||
              response.headers['X-Modality'] === 'ultrasound' ||
              response.headers['x-segmentation-format'] === 'nifti' ||
              response.headers['X-Segmentation-Format'] === 'nifti'
            );
            
            if (isUltrasoundDownload) {
              console.log('🟡 SAM2 command - Ultrasound segmentation detected - triggering file download');
              
              // Handle different response data formats
              let blobData;
              if (response.data instanceof ArrayBuffer) {
                blobData = response.data;
              } else if (response.data instanceof Uint8Array) {
                blobData = response.data.buffer;
              } else if (typeof response.data === 'string') {
                // Convert string to ArrayBuffer
                const encoder = new TextEncoder();
                blobData = encoder.encode(response.data).buffer;
              } else {
                console.error('Unexpected response data type:', typeof response.data);
                blobData = response.data;
              }
              
              const blob = new Blob([blobData], { type: 'application/octet-stream' });
              const filename = 'ultrasound_segmentation.nii.gz';
              
              console.log('🟡 SAM2 command - Created blob:', blob);
              console.log('🟡 SAM2 command - Blob size:', blob.size);
              
              // Trigger file download
              if (window.navigator.msSaveOrOpenBlob) {
                window.navigator.msSaveOrOpenBlob(blob, filename);
              } else {
                const a = document.createElement('a');
                document.body.appendChild(a);
                const url = window.URL.createObjectURL(blob);
                a.href = url;
                a.download = filename;
                a.click();
                setTimeout(() => {
                  window.URL.revokeObjectURL(url);
                  document.body.removeChild(a);
                }, 0);
              }
              
              uiNotificationService.show({
                title: 'MONAI Label',
                message: 'Ultrasound segmentation downloaded as NIfTI file',
                type: 'success',
                duration: 5000,
              });
              
              return response; // Exit early for ultrasound downloads
            }
            
            // Normal DICOM segmentation processing for non-ultrasound images
            uiNotificationService.show({
              title: 'MONAI Label',
              message: 'Run Segmentation - Successful',
              type: 'success',
              duration: 2000,
            });
            let currentDate = utils.formatDate(Date.now(), 'YYYYMMDD')
            displaySetService.activeDisplaySets = displaySetService.activeDisplaySets.filter(e => {
              return (e.SeriesDescription != 'SAM2_' + currentDisplaySets.SeriesDescription) || (e.SeriesDate != currentDate);
            })

            let studyInstanceUID = currentDisplaySets.StudyInstanceUID
            let studyInstanceUIDs = [studyInstanceUID, 1]
            let dataSource = extensionManager.getActiveDataSource()[0]
            let filters = { 'StudyInstanceUIDs': [studyInstanceUID] }
            let appConfig = config
            defaultRouteInit({ servicesManager, studyInstanceUIDs, dataSource, filters, appConfig }, "default").then(function (unsub) {

              const displaySets = displaySetService.activeDisplaySets;
              const currentDisplaySet = displaySets.filter(e => {
                return (e.SeriesDescription == 'SAM2_' + currentDisplaySets.SeriesDescription) && (e.SeriesDate == currentDate);
              })[0];
              let updatedViewports = hangingProtocolService.getViewportsRequireUpdate(activeViewportId, currentDisplaySet.displaySetInstanceUID, true)
              viewportGridService.setDisplaySetsForViewports(updatedViewports)
            })
          }
          return response;
        })
        .catch(function (error) {
          return error;
        })
        .finally(function () { });
    },
    saveAndNextObj: () => {
      servicesManager.services.measurementService.clearMeasurements()
      servicesManager.services.cornerstoneViewportService.resize()
      if(useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj===undefined){
        useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj=1
      }
      useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj=useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj+1
    },
    jumpToSegment: () => {
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation('default');
      if (activeSegmentation != undefined) {
        segmentationService.jumpToSegmentCenter(activeSegmentation.segmentationId, 1, 'default')
      }
    },
    toggleCurrentSegment: () => {
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation('default');
      if (activeSegmentation != undefined) {
        segmentationService.toggleSegmentationRepresentationVisibility('default', {
          segmentationId: activeSegmentation.segmentationId,
          type: csToolsEnums.SegmentationRepresentations.Labelmap
        });
      }
    },

    /**
     * Toggle viewport overlay (the information panel shown on the four corners
     * of the viewport)
     * @see ViewportOverlay and CustomizableViewportOverlay components
     */
    toggleOverlays: () => {
      const overlays = document.getElementsByClassName('viewport-overlay');
      for (let i = 0; i < overlays.length; i++) {
        overlays.item(i).classList.toggle('hidden');
      }
    },

    scrollActiveThumbnailIntoView: () => {
      const { activeViewportId, viewports } = viewportGridService.getState();

      const activeViewport = viewports.get(activeViewportId);
      const activeDisplaySetInstanceUID = activeViewport.displaySetInstanceUIDs[0];

      const thumbnailList = document.querySelector('#ohif-thumbnail-list');

      if (!thumbnailList) {
        return;
      }

      const thumbnailListBounds = thumbnailList.getBoundingClientRect();

      const thumbnail = document.querySelector(`#thumbnail-${activeDisplaySetInstanceUID}`);

      if (!thumbnail) {
        return;
      }

      const thumbnailBounds = thumbnail.getBoundingClientRect();

      // This only handles a vertical thumbnail list.
      if (
        thumbnailBounds.top >= thumbnailListBounds.top &&
        thumbnailBounds.top <= thumbnailListBounds.bottom
      ) {
        return;
      }

      thumbnail.scrollIntoView({ behavior: 'smooth' });
    },

    updateViewportDisplaySet: ({
      direction,
      excludeNonImageModalities,
    }: UpdateViewportDisplaySetParams) => {
      const nonImageModalities = ['SR', 'SEG', 'SM', 'RTSTRUCT', 'RTPLAN', 'RTDOSE'];

      const currentDisplaySets = [...displaySetService.activeDisplaySets];

      const { activeViewportId, viewports, isHangingProtocolLayout } =
        viewportGridService.getState();

      const { displaySetInstanceUIDs } = viewports.get(activeViewportId);

      const activeDisplaySetIndex = currentDisplaySets.findIndex(displaySet =>
        displaySetInstanceUIDs.includes(displaySet.displaySetInstanceUID)
      );

      let displaySetIndexToShow: number;

      for (
        displaySetIndexToShow = activeDisplaySetIndex + direction;
        displaySetIndexToShow > -1 && displaySetIndexToShow < currentDisplaySets.length;
        displaySetIndexToShow += direction
      ) {
        if (
          !excludeNonImageModalities ||
          !nonImageModalities.includes(currentDisplaySets[displaySetIndexToShow].Modality)
        ) {
          break;
        }
      }

      if (displaySetIndexToShow < 0 || displaySetIndexToShow >= currentDisplaySets.length) {
        return;
      }

      const { displaySetInstanceUID } = currentDisplaySets[displaySetIndexToShow];

      let updatedViewports = [];

      try {
        updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
          activeViewportId,
          displaySetInstanceUID,
          isHangingProtocolLayout
        );
      } catch (error) {
        console.warn(error);
        uiNotificationService.show({
          title: 'Navigate Viewport Display Set',
          message:
            'The requested display sets could not be added to the viewport due to a mismatch in the Hanging Protocol rules.',
          type: 'info',
          duration: 3000,
        });
      }

      viewportGridService.setDisplaySetsForViewports(updatedViewports);

      setTimeout(() => actions.scrollActiveThumbnailIntoView(), 0);
    },
  };

  const definitions = {
    showContextMenu: {
      commandFn: actions.showContextMenu,
    },
    closeContextMenu: {
      commandFn: actions.closeContextMenu,
    },
    clearMeasurements: {
      commandFn: actions.clearMeasurements,
    },
    displayNotification: {
      commandFn: actions.displayNotification,
    },
    setHangingProtocol: {
      commandFn: actions.setHangingProtocol,
    },
    toggleHangingProtocol: {
      commandFn: actions.toggleHangingProtocol,
    },
    navigateHistory: {
      commandFn: actions.navigateHistory,
    },
    nextStage: {
      commandFn: actions.deltaStage,
      options: { direction: 1 },
    },
    previousStage: {
      commandFn: actions.deltaStage,
      options: { direction: -1 },
    },
    setViewportGridLayout: {
      commandFn: actions.setViewportGridLayout,
    },
    toggleOneUp: {
      commandFn: actions.toggleOneUp,
    },
    openDICOMTagViewer: {
      commandFn: actions.openDICOMTagViewer,
    },
    sam2: {
      commandFn: actions.sam2,
    },
    sam2_one: {
      commandFn: actions.sam2_one,
    },
    saveAndNextObj: {
      commandFn: actions.saveAndNextObj,
    },
    jumpToSegment: {
      commandFn: actions.jumpToSegment,
    },
    toggleCurrentSegment: {
      commandFn: actions.toggleCurrentSegment,
    },
    updateViewportDisplaySet: {
      commandFn: actions.updateViewportDisplaySet,
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'DEFAULT',
  };
};

export default commandsModule;
