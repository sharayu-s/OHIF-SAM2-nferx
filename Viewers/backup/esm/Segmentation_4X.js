import { asyncToGenerator as _asyncToGenerator, regeneratorRuntime as _regeneratorRuntime, toConsumableArray as _toConsumableArray, createForOfIteratorHelper as _createForOfIteratorHelper, slicedToArray as _slicedToArray } from '../../_virtual/_rollupPluginBabelHelpers.js';
import { utilities, data, normalizers, derivations, log } from 'dcmjs';
import ndarray from 'ndarray';
import getDatasetsFromImages from '../helpers/getDatasetsFromImages.js';
import checkOrientation from '../helpers/checkOrientation.js';
import compareArrays from '../helpers/compareArrays.js';
import Events from '../enums/Events.js';

var _utilities$orientatio = utilities.orientation,
  rotateDirectionCosinesInPlane = _utilities$orientatio.rotateDirectionCosinesInPlane,
  flipIOP = _utilities$orientatio.flipImageOrientationPatient,
  flipMatrix2D = _utilities$orientatio.flipMatrix2D,
  rotateMatrix902D = _utilities$orientatio.rotateMatrix902D;
var BitArray = data.BitArray,
  DicomMessage = data.DicomMessage,
  DicomMetaDictionary = data.DicomMetaDictionary;
var Normalizer = normalizers.Normalizer;
var SegmentationDerivation = derivations.Segmentation;
var _utilities$compressio = utilities.compression,
  encode = _utilities$compressio.encode,
  decode = _utilities$compressio.decode;

/**
 *
 * @typedef {Object} BrushData
 * @property {Object} toolState - The cornerstoneTools global toolState.
 * @property {Object[]} segments - The cornerstoneTools segment metadata that corresponds to the
 *                                 seriesInstanceUid.
 */
var generateSegmentationDefaultOptions = {
  includeSliceSpacing: true,
  rleEncode: false
};

/**
 * generateSegmentation - Generates cornerstoneTools brush data, given a stack of
 * imageIds, images and the cornerstoneTools brushData.
 *
 * @param  {object[]} images An array of cornerstone images that contain the source
 *                           data under `image.data.byteArray.buffer`.
 * @param  {Object|Object[]} inputLabelmaps3D The cornerstone `Labelmap3D` object, or an array of objects.
 * @param  {Object} userOptions Options to pass to the segmentation derivation and `fillSegmentation`.
 * @returns {Blob}
 */
function generateSegmentation(images, inputLabelmaps3D) {
  var userOptions = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  var isMultiframe = images[0].imageId.includes("?frame");
  var segmentation = _createSegFromImages(images, isMultiframe, userOptions);
  return fillSegmentation(segmentation, inputLabelmaps3D, userOptions);
}

/**
 * Fills a given segmentation object with data from the input labelmaps3D
 *
 * @param segmentation - The segmentation object to be filled.
 * @param inputLabelmaps3D - An array of 3D labelmaps, or a single 3D labelmap.
 * @param userOptions - Optional configuration settings. Will override the default options.
 *
 * @returns {object} The filled segmentation object.
 */
function fillSegmentation(segmentation, inputLabelmaps3D) {
  var userOptions = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  var options = Object.assign({}, generateSegmentationDefaultOptions, userOptions);

  // Use another variable so we don't redefine labelmaps3D.
  var labelmaps3D = Array.isArray(inputLabelmaps3D) ? inputLabelmaps3D : [inputLabelmaps3D];
  var numberOfFrames = 0;
  var referencedFramesPerLabelmap = [];
  var _loop = function _loop() {
    var labelmap3D = labelmaps3D[labelmapIndex];
    var labelmaps2D = labelmap3D.labelmaps2D,
      metadata = labelmap3D.metadata;
    var referencedFramesPerSegment = [];
    for (var i = 1; i < metadata.length; i++) {
      if (metadata[i]) {
        referencedFramesPerSegment[i] = [];
      }
    }
    var _loop2 = function _loop2(_i) {
      var labelmap2D = labelmaps2D[_i];
      if (labelmaps2D[_i]) {
        var segmentsOnLabelmap = labelmap2D.segmentsOnLabelmap;
        segmentsOnLabelmap.forEach(function (segmentIndex) {
          if (segmentIndex !== 0) {
            referencedFramesPerSegment[segmentIndex].push(_i);
            numberOfFrames++;
          }
        });
      }
    };
    for (var _i = 0; _i < labelmaps2D.length; _i++) {
      _loop2(_i);
    }
    referencedFramesPerLabelmap[labelmapIndex] = referencedFramesPerSegment;
  };
  for (var labelmapIndex = 0; labelmapIndex < labelmaps3D.length; labelmapIndex++) {
    _loop();
  }
  segmentation.setNumberOfFrames(numberOfFrames);
  for (var _labelmapIndex = 0; _labelmapIndex < labelmaps3D.length; _labelmapIndex++) {
    var referencedFramesPerSegment = referencedFramesPerLabelmap[_labelmapIndex];
    var labelmap3D = labelmaps3D[_labelmapIndex];
    var metadata = labelmap3D.metadata;
    for (var segmentIndex = 1; segmentIndex < referencedFramesPerSegment.length; segmentIndex++) {
      var referencedFrameIndicies = referencedFramesPerSegment[segmentIndex];
      if (referencedFrameIndicies) {
        // Frame numbers start from 1.
        var referencedFrameNumbers = referencedFrameIndicies.map(function (element) {
          return element + 1;
        });
        var segmentMetadata = metadata[segmentIndex];
        var labelmaps = _getLabelmapsFromReferencedFrameIndicies(labelmap3D, referencedFrameIndicies);
        segmentation.addSegmentFromLabelmap(segmentMetadata, labelmaps, segmentIndex, referencedFrameNumbers);
      }
    }
  }
  if (options.rleEncode) {
    var rleEncodedFrames = encode(segmentation.dataset.PixelData, numberOfFrames, segmentation.dataset.Rows, segmentation.dataset.Columns);

    // Must use fractional now to RLE encode, as the DICOM standard only allows BitStored && BitsAllocated
    // to be 1 for BINARY. This is not ideal and there should be a better format for compression in this manner
    // added to the standard.
    segmentation.assignToDataset({
      BitsAllocated: "8",
      BitsStored: "8",
      HighBit: "7",
      SegmentationType: "FRACTIONAL",
      SegmentationFractionalType: "PROBABILITY",
      MaximumFractionalValue: "255"
    });
    segmentation.dataset._meta.TransferSyntaxUID = {
      Value: ["1.2.840.10008.1.2.5"],
      vr: "UI"
    };
    segmentation.dataset.SpecificCharacterSet = "ISO_IR 192";
    segmentation.dataset._vrMap.PixelData = "OB";
    segmentation.dataset.PixelData = rleEncodedFrames;
  } else {
    // If no rleEncoding, at least bitpack the data.
    segmentation.bitPackPixelData();
  }
  return segmentation;
}
function _getLabelmapsFromReferencedFrameIndicies(labelmap3D, referencedFrameIndicies) {
  var labelmaps2D = labelmap3D.labelmaps2D;
  var labelmaps = [];
  for (var i = 0; i < referencedFrameIndicies.length; i++) {
    var frame = referencedFrameIndicies[i];
    labelmaps.push(labelmaps2D[frame].pixelData);
  }
  return labelmaps;
}

/**
 * _createSegFromImages - description
 *
 * @param  {Object[]} images    An array of the cornerstone image objects.
 * @param  {Boolean} isMultiframe Whether the images are multiframe.
 * @returns {Object}              The Seg derived dataSet.
 */
function _createSegFromImages(images, isMultiframe, options) {
  var multiframe = getDatasetsFromImages(images, isMultiframe);
  return new SegmentationDerivation([multiframe], options);
}

/**
 * generateToolState - Given a set of cornerstoneTools imageIds and a Segmentation buffer,
 * derive cornerstoneTools toolState and brush metadata.
 *
 * @param  {string[]} imageIds - An array of the imageIds.
 * @param  {ArrayBuffer} arrayBuffer - The SEG arrayBuffer.
 * @param  {*} metadataProvider.
 * @param  {obj} options - Options object.
 *
 * @return {[]ArrayBuffer}a list of array buffer for each labelMap
 * @return {Object} an object from which the segment metadata can be derived
 * @return {[][][]} 2D list containing the track of segments per frame
 * @return {[][][]} 3D list containing the track of segments per frame for each labelMap
 *                  (available only for the overlapping case).
 */
function generateToolState(_x, _x2, _x3, _x4) {
  return _generateToolState.apply(this, arguments);
} // function insertPixelDataPerpendicular(
//     segmentsOnFrame,
//     labelmapBuffer,
//     pixelData,
//     multiframe,
//     imageIds,
//     validOrientations,
//     metadataProvider
// ) {
//     const {
//         SharedFunctionalGroupsSequence,
//         PerFrameFunctionalGroupsSequence,
//         Rows,
//         Columns
//     } = multiframe;
//     const firstImagePlaneModule = metadataProvider.get(
//         "imagePlaneModule",
//         imageIds[0]
//     );
//     const lastImagePlaneModule = metadataProvider.get(
//         "imagePlaneModule",
//         imageIds[imageIds.length - 1]
//     );
//     console.log(firstImagePlaneModule);
//     console.log(lastImagePlaneModule);
//     const corners = [
//         ...getCorners(firstImagePlaneModule),
//         ...getCorners(lastImagePlaneModule)
//     ];
//     console.log(`corners:`);
//     console.log(corners);
//     const indexToWorld = mat4.create();
//     const ippFirstFrame = firstImagePlaneModule.imagePositionPatient;
//     const rowCosines = Array.isArray(firstImagePlaneModule.rowCosines)
//         ? [...firstImagePlaneModule.rowCosines]
//         : [
//               firstImagePlaneModule.rowCosines.x,
//               firstImagePlaneModule.rowCosines.y,
//               firstImagePlaneModule.rowCosines.z
//           ];
//     const columnCosines = Array.isArray(firstImagePlaneModule.columnCosines)
//         ? [...firstImagePlaneModule.columnCosines]
//         : [
//               firstImagePlaneModule.columnCosines.x,
//               firstImagePlaneModule.columnCosines.y,
//               firstImagePlaneModule.columnCosines.z
//           ];
//     const { pixelSpacing } = firstImagePlaneModule;
//     mat4.set(
//         indexToWorld,
//         // Column 1
//         0,
//         0,
//         0,
//         ippFirstFrame[0],
//         // Column 2
//         0,
//         0,
//         0,
//         ippFirstFrame[1],
//         // Column 3
//         0,
//         0,
//         0,
//         ippFirstFrame[2],
//         // Column 4
//         0,
//         0,
//         0,
//         1
//     );
//     // TODO -> Get origin and (x,y,z) increments to build a translation matrix:
//     // TODO -> Equation C.7.6.2.1-1
//     // | cx*di rx* Xx 0 |  |x|
//     // | cy*di ry Xy 0 |  |y|
//     // | cz*di rz Xz 0 |  |z|
//     // | tx ty tz 1 |  |1|
//     // const [
//     //     0, 0 , 0 , 0,
//     //     0, 0 , 0 , 0,
//     //     0, 0 , 0 , 0,
//     //     ipp[0], ipp[1] , ipp[2] , 1,
//     // ]
//     // Each frame:
//     // Find which corner the first voxel lines up with (one of 8 corners.)
//     // Find how i,j,k orient with respect to source volume.
//     // Go through each frame, find location in source to start, and whether to increment +/ix,+/-y,+/-z
//     //   through each voxel.
//     // [1,0,0,0,1,0]
//     // const [
//     // ]
//     // Invert transformation matrix to get worldToIndex
//     // Apply world to index on each point to fill up the matrix.
//     // const sharedImageOrientationPatient = SharedFunctionalGroupsSequence.PlaneOrientationSequence
//     //     ? SharedFunctionalGroupsSequence.PlaneOrientationSequence
//     //           .ImageOrientationPatient
//     //     : undefined;
//     // const sliceLength = Columns * Rows;
// }
// function getCorners(imagePlaneModule) {
//     // console.log(imagePlaneModule);
//     const {
//         rows,
//         columns,
//         rowCosines,
//         columnCosines,
//         imagePositionPatient: ipp,
//         rowPixelSpacing,
//         columnPixelSpacing
//     } = imagePlaneModule;
//     const rowLength = columns * columnPixelSpacing;
//     const columnLength = rows * rowPixelSpacing;
//     const entireRowVector = [
//         rowLength * columnCosines[0],
//         rowLength * columnCosines[1],
//         rowLength * columnCosines[2]
//     ];
//     const entireColumnVector = [
//         columnLength * rowCosines[0],
//         columnLength * rowCosines[1],
//         columnLength * rowCosines[2]
//     ];
//     const topLeft = [ipp[0], ipp[1], ipp[2]];
//     const topRight = [
//         topLeft[0] + entireRowVector[0],
//         topLeft[1] + entireRowVector[1],
//         topLeft[2] + entireRowVector[2]
//     ];
//     const bottomLeft = [
//         topLeft[0] + entireColumnVector[0],
//         topLeft[1] + entireColumnVector[1],
//         topLeft[2] + entireColumnVector[2]
//     ];
//     const bottomRight = [
//         bottomLeft[0] + entireRowVector[0],
//         bottomLeft[1] + entireRowVector[1],
//         bottomLeft[2] + entireRowVector[2]
//     ];
//     return [topLeft, topRight, bottomLeft, bottomRight];
// }
/**
 * Find the reference frame of the segmentation frame in the source data.
 *
 * @param  {Object}      multiframe        dicom metadata
 * @param  {Int}         frameSegment      frame dicom index
 * @param  {String[]}    imageIds          A list of imageIds.
 * @param  {Object}      sopUIDImageIdIndexMap  A map of SOPInstanceUID to imageId
 * @param  {Float}       tolerance         The tolerance parameter
 *
 * @returns {String}     Returns the imageId
 */
function _generateToolState() {
  _generateToolState = _asyncToGenerator(/*#__PURE__*/_regeneratorRuntime().mark(function _callee(imageIds, arrayBuffer, metadataProvider, options) {
    var _options$skipOverlapp, skipOverlapping, _options$tolerance, tolerance, _options$TypedArrayCo, TypedArrayConstructor, _options$maxBytesPerC, maxBytesPerChunk, eventTarget, triggerEvent, dicomData, dataset, multiframe, imagePlaneModule, generalSeriesModule, SeriesInstanceUID, ImageOrientationPatient, validOrientations, sliceLength, segMetadata, TransferSyntaxUID, pixelData, pixelDataChunks, rleEncodedFrames, orientation, sopUIDImageIdIndexMap, overlapping, insertFunction, segmentsOnFrameArray, segmentsOnFrame, arrayBufferLength, labelmapBufferArray, imageIdMaps, segmentsPixelIndices, overlappingSegments, centroidXYZ;
    return _regeneratorRuntime().wrap(function _callee$(_context) {
      while (1) switch (_context.prev = _context.next) {
        case 0:
          _options$skipOverlapp = options.skipOverlapping, skipOverlapping = _options$skipOverlapp === void 0 ? false : _options$skipOverlapp, _options$tolerance = options.tolerance, tolerance = _options$tolerance === void 0 ? 1e-3 : _options$tolerance, _options$TypedArrayCo = options.TypedArrayConstructor, TypedArrayConstructor = _options$TypedArrayCo === void 0 ? Uint8Array : _options$TypedArrayCo, _options$maxBytesPerC = options.maxBytesPerChunk, maxBytesPerChunk = _options$maxBytesPerC === void 0 ? 199000000 : _options$maxBytesPerC, eventTarget = options.eventTarget, triggerEvent = options.triggerEvent;
          dicomData = DicomMessage.readFile(arrayBuffer);
          dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
          dataset._meta = DicomMetaDictionary.namifyDataset(dicomData.meta);
          multiframe = Normalizer.normalizeToDataset([dataset]);
          imagePlaneModule = metadataProvider.get("imagePlaneModule", imageIds[0]);
          generalSeriesModule = metadataProvider.get("generalSeriesModule", imageIds[0]);
          SeriesInstanceUID = generalSeriesModule.seriesInstanceUID;
          if (!imagePlaneModule) {
            console.warn("Insufficient metadata, imagePlaneModule missing.");
          }
          ImageOrientationPatient = Array.isArray(imagePlaneModule.rowCosines) ? [].concat(_toConsumableArray(imagePlaneModule.rowCosines), _toConsumableArray(imagePlaneModule.columnCosines)) : [imagePlaneModule.rowCosines.x, imagePlaneModule.rowCosines.y, imagePlaneModule.rowCosines.z, imagePlaneModule.columnCosines.x, imagePlaneModule.columnCosines.y, imagePlaneModule.columnCosines.z]; // Get IOP from ref series, compute supported orientations:
          validOrientations = getValidOrientations(ImageOrientationPatient);
          sliceLength = multiframe.Columns * multiframe.Rows;
          segMetadata = getSegmentMetadata(multiframe, SeriesInstanceUID);
          TransferSyntaxUID = multiframe._meta.TransferSyntaxUID.Value[0];
          if (!(TransferSyntaxUID === "1.2.840.10008.1.2.5")) {
            _context.next = 23;
            break;
          }
          rleEncodedFrames = Array.isArray(multiframe.PixelData) ? multiframe.PixelData : [multiframe.PixelData];
          pixelData = decode(rleEncodedFrames, multiframe.Rows, multiframe.Columns);
          if (!(multiframe.BitsStored === 1)) {
            _context.next = 20;
            break;
          }
          console.warn("No implementation for rle + bitbacking.");
          return _context.abrupt("return");
        case 20:
          // Todo: need to test this with rle data
          pixelDataChunks = [pixelData];
          _context.next = 26;
          break;
        case 23:
          pixelDataChunks = unpackPixelData(multiframe, {
            maxBytesPerChunk: maxBytesPerChunk
          });
          if (pixelDataChunks) {
            _context.next = 26;
            break;
          }
          throw new Error("Fractional segmentations are not yet supported");
        case 26:
          orientation = checkOrientation(multiframe, validOrientations, [imagePlaneModule.rows, imagePlaneModule.columns, imageIds.length], tolerance); // Pre-compute the sop UID to imageId index map so that in the for loop
          // we don't have to call metadataProvider.get() for each imageId over
          // and over again.
          sopUIDImageIdIndexMap = imageIds.reduce(function (acc, imageId) {
            var _metadataProvider$get = metadataProvider.get("generalImageModule", imageId),
              sopInstanceUID = _metadataProvider$get.sopInstanceUID;
            acc[sopInstanceUID] = imageId;
            return acc;
          }, {});
          overlapping = false;
          if (!skipOverlapping) {
            overlapping = checkSEGsOverlapping(pixelDataChunks, multiframe, imageIds, validOrientations, metadataProvider, tolerance, TypedArrayConstructor, sopUIDImageIdIndexMap);
          }
          _context.t0 = orientation;
          _context.next = _context.t0 === "Planar" ? 33 : _context.t0 === "Perpendicular" ? 35 : _context.t0 === "Oblique" ? 36 : 37;
          break;
        case 33:
          if (overlapping) {
            insertFunction = insertOverlappingPixelDataPlanar;
          } else {
            insertFunction = insertPixelDataPlanar;
          }
          return _context.abrupt("break", 37);
        case 35:
          throw new Error("Segmentations orthogonal to the acquisition plane of the source data are not yet supported.");
        case 36:
          throw new Error("Segmentations oblique to the acquisition plane of the source data are not yet supported.");
        case 37:
          /* if SEGs are overlapping:
          1) the labelmapBuffer will contain M volumes which have non-overlapping segments;
          2) segmentsOnFrame will have M * numberOfFrames values to track in which labelMap are the segments;
          3) insertFunction will return the number of LabelMaps
          4) generateToolState return is an array*/
          segmentsOnFrameArray = [];
          segmentsOnFrameArray[0] = [];
          segmentsOnFrame = [];
          arrayBufferLength = sliceLength * imageIds.length * TypedArrayConstructor.BYTES_PER_ELEMENT;
          labelmapBufferArray = [];
          labelmapBufferArray[0] = new ArrayBuffer(arrayBufferLength);

          // Pre-compute the indices and metadata so that we don't have to call
          // a function for each imageId in the for loop.
          imageIdMaps = imageIds.reduce(function (acc, curr, index) {
            acc.indices[curr] = index;
            acc.metadata[curr] = metadataProvider.get("instance", curr);
            return acc;
          }, {
            indices: {},
            metadata: {}
          }); // This is the centroid calculation for each segment Index, the data structure
          // is a Map with key = segmentIndex and value = {imageIdIndex: centroid, ...}
          // later on we will use this data structure to calculate the centroid of the
          // segment in the labelmapBuffer
          segmentsPixelIndices = new Map();
          _context.next = 47;
          return insertFunction(segmentsOnFrame, segmentsOnFrameArray, labelmapBufferArray, pixelDataChunks, multiframe, imageIds, validOrientations, metadataProvider, tolerance, TypedArrayConstructor, segmentsPixelIndices, sopUIDImageIdIndexMap, imageIdMaps, eventTarget, triggerEvent);
        case 47:
          overlappingSegments = _context.sent;
          // calculate the centroid of each segment
          centroidXYZ = new Map();
          segmentsPixelIndices.forEach(function (imageIdIndexBufferIndex, segmentIndex) {
            var centroids = calculateCentroid(imageIdIndexBufferIndex, multiframe, metadataProvider, imageIds);
            centroidXYZ.set(segmentIndex, centroids);
          });
          return _context.abrupt("return", {
            labelmapBufferArray: labelmapBufferArray,
            segMetadata: segMetadata,
            segmentsOnFrame: segmentsOnFrame,
            segmentsOnFrameArray: segmentsOnFrameArray,
            centroids: centroidXYZ,
            overlappingSegments: overlappingSegments
          });
        case 51:
        case "end":
          return _context.stop();
      }
    }, _callee);
  }));
  return _generateToolState.apply(this, arguments);
}
function findReferenceSourceImageId(multiframe, frameSegment, imageIds, metadataProvider, tolerance, sopUIDImageIdIndexMap) {
  var imageId = undefined;
  if (!multiframe) {
    return imageId;
  }
  var FrameOfReferenceUID = multiframe.FrameOfReferenceUID,
    PerFrameFunctionalGroupsSequence = multiframe.PerFrameFunctionalGroupsSequence,
    SourceImageSequence = multiframe.SourceImageSequence,
    ReferencedSeriesSequence = multiframe.ReferencedSeriesSequence;
  if (!PerFrameFunctionalGroupsSequence || PerFrameFunctionalGroupsSequence.length === 0) {
    return imageId;
  }
  var PerFrameFunctionalGroup = PerFrameFunctionalGroupsSequence[frameSegment];
  if (!PerFrameFunctionalGroup) {
    return imageId;
  }
  var frameSourceImageSequence = undefined;
  if (PerFrameFunctionalGroup.DerivationImageSequence) {
    var DerivationImageSequence = PerFrameFunctionalGroup.DerivationImageSequence;
    if (Array.isArray(DerivationImageSequence)) {
      if (DerivationImageSequence.length !== 0) {
        DerivationImageSequence = DerivationImageSequence[0];
      } else {
        DerivationImageSequence = undefined;
      }
    }
    if (DerivationImageSequence) {
      frameSourceImageSequence = DerivationImageSequence.SourceImageSequence;
      if (Array.isArray(frameSourceImageSequence)) {
        if (frameSourceImageSequence.length !== 0) {
          frameSourceImageSequence = frameSourceImageSequence[0];
        } else {
          frameSourceImageSequence = undefined;
        }
      }
    }
  } else if (SourceImageSequence && SourceImageSequence.length !== 0) {
    console.warn("DerivationImageSequence not present, using SourceImageSequence assuming SEG has the same geometry as the source image.");
    frameSourceImageSequence = SourceImageSequence[frameSegment];
  }
  if (frameSourceImageSequence) {
    imageId = getImageIdOfSourceImageBySourceImageSequence(frameSourceImageSequence, sopUIDImageIdIndexMap);
  }
  if (imageId === undefined && ReferencedSeriesSequence) {
    var referencedSeriesSequence = Array.isArray(ReferencedSeriesSequence) ? ReferencedSeriesSequence[0] : ReferencedSeriesSequence;
    var ReferencedSeriesInstanceUID = referencedSeriesSequence.SeriesInstanceUID;
    imageId = getImageIdOfSourceImagebyGeometry(ReferencedSeriesInstanceUID, FrameOfReferenceUID, PerFrameFunctionalGroup, imageIds, metadataProvider, tolerance);
  }
  return imageId;
}

/**
 * Checks if there is any overlapping segmentations.
 *  @returns {boolean} Returns a flag if segmentations overlapping
 */

function checkSEGsOverlapping(pixelData, multiframe, imageIds, validOrientations, metadataProvider, tolerance, TypedArrayConstructor, sopUIDImageIdIndexMap) {
  var SharedFunctionalGroupsSequence = multiframe.SharedFunctionalGroupsSequence,
    PerFrameFunctionalGroupsSequence = multiframe.PerFrameFunctionalGroupsSequence,
    SegmentSequence = multiframe.SegmentSequence,
    Rows = multiframe.Rows,
    Columns = multiframe.Columns;
  var numberOfSegs = SegmentSequence.length;
  if (numberOfSegs < 2) {
    return false;
  }
  var sharedImageOrientationPatient = SharedFunctionalGroupsSequence.PlaneOrientationSequence ? SharedFunctionalGroupsSequence.PlaneOrientationSequence.ImageOrientationPatient : undefined;
  var sliceLength = Columns * Rows;
  var groupsLen = PerFrameFunctionalGroupsSequence.length;

  /** sort groupsLen to have all the segments for each frame in an array
   * frame 2 : 1, 2
   * frame 4 : 1, 3
   * frame 5 : 4
   */

  var frameSegmentsMapping = new Map();
  var _loop3 = function _loop3() {
      var segmentIndex = getSegmentIndex(multiframe, frameSegment);
      if (segmentIndex === undefined) {
        console.warn("Could not retrieve the segment index for frame segment " + frameSegment + ", skipping this frame.");
        return 0; // continue
      }
      var imageId = findReferenceSourceImageId(multiframe, frameSegment, imageIds, metadataProvider, tolerance, sopUIDImageIdIndexMap);
      if (!imageId) {
        console.warn("Image not present in stack, can't import frame : " + frameSegment + ".");
        return 0; // continue
      }
      var imageIdIndex = imageIds.findIndex(function (element) {
        return element === imageId;
      });
      if (frameSegmentsMapping.has(imageIdIndex)) {
        var segmentArray = frameSegmentsMapping.get(imageIdIndex);
        if (!segmentArray.includes(frameSegment)) {
          segmentArray.push(frameSegment);
          frameSegmentsMapping.set(imageIdIndex, segmentArray);
        }
      } else {
        frameSegmentsMapping.set(imageIdIndex, [frameSegment]);
      }
    },
    _ret;
  for (var frameSegment = 0; frameSegment < groupsLen; ++frameSegment) {
    _ret = _loop3();
    if (_ret === 0) continue;
  }
  var _iterator = _createForOfIteratorHelper(frameSegmentsMapping.entries()),
    _step;
  try {
    for (_iterator.s(); !(_step = _iterator.n()).done;) {
      var _step$value = _slicedToArray(_step.value, 2),
        role = _step$value[1];
      var temp2DArray = new TypedArrayConstructor(sliceLength).fill(0);
      for (var i = 0; i < role.length; ++i) {
        var _frameSegment = role[i];
        var PerFrameFunctionalGroups = PerFrameFunctionalGroupsSequence[_frameSegment];
        var ImageOrientationPatientI = sharedImageOrientationPatient || PerFrameFunctionalGroups.PlaneOrientationSequence.ImageOrientationPatient;
        var view = readFromUnpackedChunks(pixelData, _frameSegment * sliceLength, sliceLength);
        var pixelDataI2D = ndarray(view, [Rows, Columns]);
        var alignedPixelDataI = alignPixelDataWithSourceData(pixelDataI2D, ImageOrientationPatientI, validOrientations, tolerance);
        if (!alignedPixelDataI) {
          console.warn("Individual SEG frames are out of plane with respect to the first SEG frame, this is not yet supported, skipping this frame.");
          continue;
        }
        var data = alignedPixelDataI.data;
        for (var j = 0, len = data.length; j < len; ++j) {
          if (data[j] !== 0) {
            temp2DArray[j]++;
            if (temp2DArray[j] > 1) {
              return true;
            }
          }
        }
      }
    }
  } catch (err) {
    _iterator.e(err);
  } finally {
    _iterator.f();
  }
  return false;
}
function insertOverlappingPixelDataPlanar(segmentsOnFrame, segmentsOnFrameArray, labelmapBufferArray, pixelData, multiframe, imageIds, validOrientations, metadataProvider, tolerance, TypedArrayConstructor, segmentsPixelIndices, sopUIDImageIdIndexMap) {
  var SharedFunctionalGroupsSequence = multiframe.SharedFunctionalGroupsSequence,
    PerFrameFunctionalGroupsSequence = multiframe.PerFrameFunctionalGroupsSequence,
    Rows = multiframe.Rows,
    Columns = multiframe.Columns;
  var sharedImageOrientationPatient = SharedFunctionalGroupsSequence.PlaneOrientationSequence ? SharedFunctionalGroupsSequence.PlaneOrientationSequence.ImageOrientationPatient : undefined;
  var sliceLength = Columns * Rows;
  var arrayBufferLength = sliceLength * imageIds.length * TypedArrayConstructor.BYTES_PER_ELEMENT;
  // indicate the number of labelMaps
  var M = 1;

  // indicate the current labelMap array index;
  var m = 0;

  // temp array for checking overlaps
  var tempBuffer = labelmapBufferArray[m].slice(0);

  // temp list for checking overlaps
  var tempSegmentsOnFrame = structuredClone(segmentsOnFrameArray[m]);

  /** split overlapping SEGs algorithm for each segment:
   *  A) copy the labelmapBuffer in the array with index 0
   *  B) add the segment pixel per pixel on the copied buffer from (A)
   *  C) if no overlap, copy the results back on the orignal array from (A)
   *  D) if overlap, repeat increasing the index m up to M (if out of memory, add new buffer in the array and M++);
   */

  var numberOfSegs = multiframe.SegmentSequence.length;
  for (var segmentIndexToProcess = 1; segmentIndexToProcess <= numberOfSegs; ++segmentIndexToProcess) {
    var _loop4 = function _loop4(_i2) {
        var PerFrameFunctionalGroups = PerFrameFunctionalGroupsSequence[_i2];
        var segmentIndex = getSegmentIndex(multiframe, _i2);
        if (segmentIndex === undefined) {
          throw new Error("Could not retrieve the segment index. Aborting segmentation loading.");
        }
        if (segmentIndex !== segmentIndexToProcess) {
          i = _i2;
          return 0; // continue
        }
        var ImageOrientationPatientI = sharedImageOrientationPatient || PerFrameFunctionalGroups.PlaneOrientationSequence.ImageOrientationPatient;

        // Since we moved to the chunks approach, we need to read the data
        // and handle scenarios where the portion of data is in one chunk
        // and the other portion is in another chunk
        var view = readFromUnpackedChunks(pixelData, _i2 * sliceLength, sliceLength);
        var pixelDataI2D = ndarray(view, [Rows, Columns]);
        var alignedPixelDataI = alignPixelDataWithSourceData(pixelDataI2D, ImageOrientationPatientI, validOrientations, tolerance);
        if (!alignedPixelDataI) {
          throw new Error("Individual SEG frames are out of plane with respect to the first SEG frame. " + "This is not yet supported. Aborting segmentation loading.");
        }
        var imageId = findReferenceSourceImageId(multiframe, _i2, imageIds, metadataProvider, tolerance, sopUIDImageIdIndexMap);
        if (!imageId) {
          console.warn("Image not present in stack, can't import frame : " + _i2 + ".");
          i = _i2;
          return 0; // continue
        }
        var sourceImageMetadata = metadataProvider.get("instance", imageId);
        if (Rows !== sourceImageMetadata.Rows || Columns !== sourceImageMetadata.Columns) {
          throw new Error("Individual SEG frames have different geometry dimensions (Rows and Columns) " + "respect to the source image reference frame. This is not yet supported. " + "Aborting segmentation loading. ");
        }
        var imageIdIndex = imageIds.findIndex(function (element) {
          return element === imageId;
        });
        var byteOffset = sliceLength * imageIdIndex * TypedArrayConstructor.BYTES_PER_ELEMENT;
        var labelmap2DView = new TypedArrayConstructor(tempBuffer, byteOffset, sliceLength);
        var data = alignedPixelDataI.data;
        var segmentOnFrame = false;
        for (var j = 0, len = alignedPixelDataI.data.length; j < len; ++j) {
          if (data[j]) {
            if (labelmap2DView[j] !== 0) {
              m++;
              if (m >= M) {
                labelmapBufferArray[m] = new ArrayBuffer(arrayBufferLength);
                segmentsOnFrameArray[m] = [];
                M++;
              }
              tempBuffer = labelmapBufferArray[m].slice(0);
              tempSegmentsOnFrame = structuredClone(segmentsOnFrameArray[m]);
              _i2 = 0;
              break;
            } else {
              labelmap2DView[j] = segmentIndex;
              segmentOnFrame = true;
            }
          }
        }
        if (segmentOnFrame) {
          if (!tempSegmentsOnFrame[imageIdIndex]) {
            tempSegmentsOnFrame[imageIdIndex] = [];
          }
          tempSegmentsOnFrame[imageIdIndex].push(segmentIndex);
          if (!segmentsOnFrame[imageIdIndex]) {
            segmentsOnFrame[imageIdIndex] = [];
          }
          segmentsOnFrame[imageIdIndex].push(segmentIndex);
        }
        i = _i2;
      },
      _ret2;
    for (var i = 0, groupsLen = PerFrameFunctionalGroupsSequence.length; i < groupsLen; ++i) {
      _ret2 = _loop4(i);
      if (_ret2 === 0) continue;
    }
    labelmapBufferArray[m] = tempBuffer.slice(0);
    segmentsOnFrameArray[m] = structuredClone(tempSegmentsOnFrame);

    // reset temp variables/buffers for new segment
    m = 0;
    tempBuffer = labelmapBufferArray[m].slice(0);
    tempSegmentsOnFrame = structuredClone(segmentsOnFrameArray[m]);
  }
}
var getSegmentIndex = function getSegmentIndex(multiframe, frame) {
  var PerFrameFunctionalGroupsSequence = multiframe.PerFrameFunctionalGroupsSequence,
    SharedFunctionalGroupsSequence = multiframe.SharedFunctionalGroupsSequence;
  var PerFrameFunctionalGroups = PerFrameFunctionalGroupsSequence[frame];
  return PerFrameFunctionalGroups && PerFrameFunctionalGroups.SegmentIdentificationSequence ? PerFrameFunctionalGroups.SegmentIdentificationSequence.ReferencedSegmentNumber : SharedFunctionalGroupsSequence.SegmentIdentificationSequence ? SharedFunctionalGroupsSequence.SegmentIdentificationSequence.ReferencedSegmentNumber : undefined;
};
function insertPixelDataPlanar(segmentsOnFrame, segmentsOnFrameArray, labelmapBufferArray, pixelData, multiframe, imageIds, validOrientations, metadataProvider, tolerance, TypedArrayConstructor, segmentsPixelIndices, sopUIDImageIdIndexMap, imageIdMaps, eventTarget, triggerEvent) {
  var SharedFunctionalGroupsSequence = multiframe.SharedFunctionalGroupsSequence,
    PerFrameFunctionalGroupsSequence = multiframe.PerFrameFunctionalGroupsSequence,
    Rows = multiframe.Rows,
    Columns = multiframe.Columns;
  var sharedImageOrientationPatient = SharedFunctionalGroupsSequence.PlaneOrientationSequence ? SharedFunctionalGroupsSequence.PlaneOrientationSequence.ImageOrientationPatient : undefined;
  var sliceLength = Columns * Rows;
  var i = 0;
  var groupsLen = PerFrameFunctionalGroupsSequence.length;
  var chunkSize = Math.ceil(groupsLen / 10); // 10% of total length

  var shouldTriggerEvent = triggerEvent && eventTarget;
  var overlapping = false;
  // Below, we chunk the processing of the frames to avoid blocking the main thread
  // if the segmentation is large. We also use a promise to allow the caller to
  // wait for the processing to finish.
  return new Promise(function (resolve) {
    function processInChunks() {
      // process one chunk
      for (var end = Math.min(i + chunkSize, groupsLen); i < end; ++i) {
        var PerFrameFunctionalGroups = PerFrameFunctionalGroupsSequence[i];
        var ImageOrientationPatientI = sharedImageOrientationPatient || PerFrameFunctionalGroups.PlaneOrientationSequence.ImageOrientationPatient;
        var view = readFromUnpackedChunks(pixelData, i * sliceLength, sliceLength);
        var pixelDataI2D = ndarray(view, [Rows, Columns]);
        var alignedPixelDataI = alignPixelDataWithSourceData(pixelDataI2D, ImageOrientationPatientI, validOrientations, tolerance);
        if (!alignedPixelDataI) {
          throw new Error("Individual SEG frames are out of plane with respect to the first SEG frame. " + "This is not yet supported. Aborting segmentation loading.");
        }
        var segmentIndex = getSegmentIndex(multiframe, i);
        if (segmentIndex === undefined) {
          throw new Error("Could not retrieve the segment index. Aborting segmentation loading.");
        }
        if (!segmentsPixelIndices.has(segmentIndex)) {
          segmentsPixelIndices.set(segmentIndex, {});
        }
        var imageId = findReferenceSourceImageId(multiframe, i, imageIds, metadataProvider, tolerance, sopUIDImageIdIndexMap);
        if (!imageId) {
          console.warn("Image not present in stack, can't import frame : " + i + ".");
          continue;
        }
        var sourceImageMetadata = imageIdMaps.metadata[imageId];
        if (Rows !== sourceImageMetadata.Rows || Columns !== sourceImageMetadata.Columns) {
          throw new Error("Individual SEG frames have different geometry dimensions (Rows and Columns) " + "respect to the source image reference frame. This is not yet supported. " + "Aborting segmentation loading. ");
        }
        var imageIdIndex = imageIdMaps.indices[imageId];
        var byteOffset = sliceLength * imageIdIndex * TypedArrayConstructor.BYTES_PER_ELEMENT;
        var labelmap2DView = new TypedArrayConstructor(labelmapBufferArray[0], byteOffset, sliceLength);
        var data = alignedPixelDataI.data;
        var indexCache = [];
        for (var j = 0, len = alignedPixelDataI.data.length; j < len; ++j) {
          if (data[j]) {
            for (var x = j; x < len; ++x) {
              if (data[x]) {
                if (!overlapping && labelmap2DView[x] !== 0) {
                  overlapping = true;
                }
                labelmap2DView[x] = segmentIndex;
                indexCache.push(x);
              }
            }
            if (!segmentsOnFrame[imageIdIndex]) {
              segmentsOnFrame[imageIdIndex] = [];
            }
            segmentsOnFrame[imageIdIndex].push(segmentIndex);
            break;
          }
        }
        var segmentIndexObject = segmentsPixelIndices.get(segmentIndex);
        segmentIndexObject[imageIdIndex] = indexCache;
        segmentsPixelIndices.set(segmentIndex, segmentIndexObject);
      }

      // trigger an event after each chunk
      if (shouldTriggerEvent) {
        var percentComplete = Math.round(i / groupsLen * 100);
        triggerEvent(eventTarget, Events.SEGMENTATION_LOAD_PROGRESS, {
          percentComplete: percentComplete
        });
      }

      // schedule next chunk
      if (i < groupsLen) {
        setTimeout(processInChunks, 0);
      } else {
        // resolve the Promise when all chunks have been processed
        resolve(overlapping);
      }
    }
    processInChunks();
  });
}

/**
 * unpackPixelData - Unpacks bit packed pixelData if the Segmentation is BINARY.
 *
 * @param  {Object} multiframe The multiframe dataset.
 * @param  {Object} options    Options for the unpacking.
 * @return {Uint8Array}      The unpacked pixelData.
 */
function unpackPixelData(multiframe, options) {
  var segType = multiframe.SegmentationType;
  var data;
  if (Array.isArray(multiframe.PixelData)) {
    data = multiframe.PixelData[0];
  } else {
    data = multiframe.PixelData;
  }
  if (data === undefined) {
    log.error("This segmentation pixelData is undefined.");
  }
  if (segType === "BINARY") {
    // For extreme big data, we can't unpack the data at once and we need to
    // chunk it and unpack each chunk separately.
    // MAX 2GB is the limit right now to allocate a buffer
    return getUnpackedChunks(data, options.maxBytesPerChunk);
  }
  var pixelData = new Uint8Array(data);
  var max = multiframe.MaximumFractionalValue;
  var onlyMaxAndZero = pixelData.find(function (element) {
    return element !== 0 && element !== max;
  }) === undefined;
  if (!onlyMaxAndZero) {
    // This is a fractional segmentation, which is not currently supported.
    return;
  }
  log.warn("This segmentation object is actually binary... processing as such.");
  return pixelData;
}
function getUnpackedChunks(data, maxBytesPerChunk) {
  var bitArray = new Uint8Array(data);
  var chunks = [];
  var maxBitsPerChunk = maxBytesPerChunk * 8;
  var numberOfChunks = Math.ceil(bitArray.length * 8 / maxBitsPerChunk);
  for (var i = 0; i < numberOfChunks; i++) {
    var startBit = i * maxBitsPerChunk;
    var endBit = Math.min(startBit + maxBitsPerChunk, bitArray.length * 8);
    var startByte = Math.floor(startBit / 8);
    var endByte = Math.ceil(endBit / 8);
    var chunk = bitArray.slice(startByte, endByte);
    var unpackedChunk = BitArray.unpack(chunk);
    chunks.push(unpackedChunk);
  }
  return chunks;
}

/**
 * getImageIdOfSourceImageBySourceImageSequence - Returns the Cornerstone imageId of the source image.
 *
 * @param  {Object}   SourceImageSequence  Sequence describing the source image.
 * @param  {String[]} imageIds             A list of imageIds.
 * @param  {Object}   sopUIDImageIdIndexMap A map of SOPInstanceUIDs to imageIds.
 * @return {String}                        The corresponding imageId.
 */
function getImageIdOfSourceImageBySourceImageSequence(SourceImageSequence, sopUIDImageIdIndexMap) {
  var ReferencedSOPInstanceUID = SourceImageSequence.ReferencedSOPInstanceUID,
    ReferencedFrameNumber = SourceImageSequence.ReferencedFrameNumber;
  return ReferencedFrameNumber ? getImageIdOfReferencedFrame(ReferencedSOPInstanceUID, ReferencedFrameNumber, sopUIDImageIdIndexMap) : sopUIDImageIdIndexMap[ReferencedSOPInstanceUID];
}

/**
 * getImageIdOfSourceImagebyGeometry - Returns the Cornerstone imageId of the source image.
 *
 * @param  {String}    ReferencedSeriesInstanceUID    Referenced series of the source image.
 * @param  {String}    FrameOfReferenceUID            Frame of reference.
 * @param  {Object}    PerFrameFunctionalGroup        Sequence describing segmentation reference attributes per frame.
 * @param  {String[]}  imageIds                       A list of imageIds.
 * @param  {Object}    sopUIDImageIdIndexMap          A map of SOPInstanceUIDs to imageIds.
 * @param  {Float}     tolerance                      The tolerance parameter
 *
 * @return {String}                                   The corresponding imageId.
 */
function getImageIdOfSourceImagebyGeometry(ReferencedSeriesInstanceUID, FrameOfReferenceUID, PerFrameFunctionalGroup, imageIds, metadataProvider, tolerance) {
  if (ReferencedSeriesInstanceUID === undefined || PerFrameFunctionalGroup.PlanePositionSequence === undefined || PerFrameFunctionalGroup.PlanePositionSequence[0] === undefined || PerFrameFunctionalGroup.PlanePositionSequence[0].ImagePositionPatient === undefined) {
    return undefined;
  }
  for (var imageIdsIndexc = 0; imageIdsIndexc < imageIds.length; ++imageIdsIndexc) {
    var sourceImageMetadata = metadataProvider.get("instance", imageIds[imageIdsIndexc]);
    if (sourceImageMetadata === undefined || sourceImageMetadata.ImagePositionPatient === undefined || sourceImageMetadata.FrameOfReferenceUID !== FrameOfReferenceUID || sourceImageMetadata.SeriesInstanceUID !== ReferencedSeriesInstanceUID) {
      continue;
    }
    if (compareArrays(PerFrameFunctionalGroup.PlanePositionSequence[0].ImagePositionPatient, sourceImageMetadata.ImagePositionPatient, tolerance)) {
      return imageIds[imageIdsIndexc];
    }
    if (PerFrameFunctionalGroup.FrameContentSequence[0]
      .DimensionIndexValues[1]=== sourceImageMetadata.InstanceNumber) { //tolerance
      return imageIds[imageIdsIndexc];
  }
  }
}

/**
 * getImageIdOfReferencedFrame - Returns the imageId corresponding to the
 * specified sopInstanceUid and frameNumber for multi-frame images.
 *
 * @param  {String} sopInstanceUid   The sopInstanceUid of the desired image.
 * @param  {Number} frameNumber      The frame number.
 * @param  {String} imageIds         The list of imageIds.
 * @param  {Object} sopUIDImageIdIndexMap A map of SOPInstanceUIDs to imageIds.
 * @return {String}                  The imageId that corresponds to the sopInstanceUid.
 */
function getImageIdOfReferencedFrame(sopInstanceUid, frameNumber, sopUIDImageIdIndexMap) {
  var imageId = sopUIDImageIdIndexMap[sopInstanceUid];
  if (!imageId) {
    return;
  }
  var imageIdFrameNumber = Number(imageId.split("frame=")[1]);
  return imageIdFrameNumber === frameNumber - 1 ? imageId : undefined;
}

/**
 * getValidOrientations - returns an array of valid orientations.
 *
 * @param  {Number[6]} iop The row (0..2) an column (3..5) direction cosines.
 * @return {Number[8][6]} An array of valid orientations.
 */
function getValidOrientations(iop) {
  var orientations = [];

  // [0,  1,  2]: 0,   0hf,   0vf
  // [3,  4,  5]: 90,  90hf,  90vf
  // [6, 7]:      180, 270

  orientations[0] = iop;
  orientations[1] = flipIOP.h(iop);
  orientations[2] = flipIOP.v(iop);
  var iop90 = rotateDirectionCosinesInPlane(iop, Math.PI / 2);
  orientations[3] = iop90;
  orientations[4] = flipIOP.h(iop90);
  orientations[5] = flipIOP.v(iop90);
  orientations[6] = rotateDirectionCosinesInPlane(iop, Math.PI);
  orientations[7] = rotateDirectionCosinesInPlane(iop, 1.5 * Math.PI);
  return orientations;
}

/**
 * alignPixelDataWithSourceData -
 *
 * @param {Ndarray} pixelData2D - The data to align.
 * @param {Number[6]} iop - The orientation of the image slice.
 * @param {Number[8][6]} orientations - An array of valid imageOrientationPatient values.
 * @param {Number} tolerance.
 * @return {Ndarray} The aligned pixelData.
 */
function alignPixelDataWithSourceData(pixelData2D, iop, orientations, tolerance) {
  if (compareArrays(iop, orientations[0], tolerance)) {
    return pixelData2D;
  } else if (compareArrays(iop, orientations[1], tolerance)) {
    // Flipped vertically.

    // Undo Flip
    return flipMatrix2D.v(pixelData2D);
  } else if (compareArrays(iop, orientations[2], tolerance)) {
    // Flipped horizontally.

    // Unfo flip
    return flipMatrix2D.h(pixelData2D);
  } else if (compareArrays(iop, orientations[3], tolerance)) {
    //Rotated 90 degrees

    // Rotate back
    return rotateMatrix902D(pixelData2D);
  } else if (compareArrays(iop, orientations[4], tolerance)) {
    //Rotated 90 degrees and fliped horizontally.

    // Undo flip and rotate back.
    return rotateMatrix902D(flipMatrix2D.h(pixelData2D));
  } else if (compareArrays(iop, orientations[5], tolerance)) {
    // Rotated 90 degrees and fliped vertically

    // Unfo flip and rotate back.
    return rotateMatrix902D(flipMatrix2D.v(pixelData2D));
  } else if (compareArrays(iop, orientations[6], tolerance)) {
    // Rotated 180 degrees. // TODO -> Do this more effeciently, there is a 1:1 mapping like 90 degree rotation.

    return rotateMatrix902D(rotateMatrix902D(pixelData2D));
  } else if (compareArrays(iop, orientations[7], tolerance)) {
    // Rotated 270 degrees

    // Rotate back.
    return rotateMatrix902D(rotateMatrix902D(rotateMatrix902D(pixelData2D)));
  }
}
function getSegmentMetadata(multiframe, seriesInstanceUid) {
  var segmentSequence = multiframe.SegmentSequence;
  var data = [];
  if (Array.isArray(segmentSequence)) {
    data = [undefined].concat(_toConsumableArray(segmentSequence));
  } else {
    // Only one segment, will be stored as an object.
    data = [undefined, segmentSequence];
  }
  return {
    seriesInstanceUid: seriesInstanceUid,
    data: data
  };
}

/**
 * Reads a range of bytes from an array of ArrayBuffer chunks and
 * aggregate them into a new Uint8Array.
 *
 * @param {ArrayBuffer[]} chunks - An array of ArrayBuffer chunks.
 * @param {number} offset - The offset of the first byte to read.
 * @param {number} length - The number of bytes to read.
 * @returns {Uint8Array} A new Uint8Array containing the requested bytes.
 */
function readFromUnpackedChunks(chunks, offset, length) {
  var mapping = getUnpackedOffsetAndLength(chunks, offset, length);

  // If all the data is in one chunk, we can just slice that chunk
  if (mapping.start.chunkIndex === mapping.end.chunkIndex) {
    return new Uint8Array(chunks[mapping.start.chunkIndex].buffer, mapping.start.offset, length);
  } else {
    // If the data spans multiple chunks, we need to create a new Uint8Array and copy the data from each chunk
    var result = new Uint8Array(length);
    var resultOffset = 0;
    for (var i = mapping.start.chunkIndex; i <= mapping.end.chunkIndex; i++) {
      var start = i === mapping.start.chunkIndex ? mapping.start.offset : 0;
      var end = i === mapping.end.chunkIndex ? mapping.end.offset : chunks[i].length;
      result.set(new Uint8Array(chunks[i].buffer, start, end - start), resultOffset);
      resultOffset += end - start;
    }
    return result;
  }
}
function getUnpackedOffsetAndLength(chunks, offset, length) {
  var totalBytes = chunks.reduce(function (total, chunk) {
    return total + chunk.length;
  }, 0);
  if (offset < 0 || offset + length > totalBytes) {
    throw new Error("Offset and length out of bounds");
  }
  var startChunkIndex = 0;
  var startOffsetInChunk = offset;
  while (startOffsetInChunk >= chunks[startChunkIndex].length) {
    startOffsetInChunk -= chunks[startChunkIndex].length;
    startChunkIndex++;
  }
  var endChunkIndex = startChunkIndex;
  var endOffsetInChunk = startOffsetInChunk + length;
  while (endOffsetInChunk > chunks[endChunkIndex].length) {
    endOffsetInChunk -= chunks[endChunkIndex].length;
    endChunkIndex++;
  }
  return {
    start: {
      chunkIndex: startChunkIndex,
      offset: startOffsetInChunk
    },
    end: {
      chunkIndex: endChunkIndex,
      offset: endOffsetInChunk
    }
  };
}
function calculateCentroid(imageIdIndexBufferIndex, multiframe, metadataProvider, imageIds) {
  var xAcc = 0;
  var yAcc = 0;
  var zAcc = 0;
  var worldXAcc = 0;
  var worldYAcc = 0;
  var worldZAcc = 0;
  var count = 0;
  for (var _i3 = 0, _Object$entries = Object.entries(imageIdIndexBufferIndex); _i3 < _Object$entries.length; _i3++) {
    var _Object$entries$_i = _slicedToArray(_Object$entries[_i3], 2),
      imageIdIndex = _Object$entries$_i[0],
      bufferIndices = _Object$entries$_i[1];
    var z = Number(imageIdIndex);
    if (!bufferIndices || bufferIndices.length === 0) {
      continue;
    }

    // Get metadata for this slice
    var imageId = imageIds[z];
    var imagePlaneModule = metadataProvider.get("imagePlaneModule", imageId);
    if (!imagePlaneModule) {
      console.debug("Missing imagePlaneModule metadata for centroid calculation");
      continue;
    }
    var imagePositionPatient = imagePlaneModule.imagePositionPatient,
      rowCosines = imagePlaneModule.rowCosines,
      columnCosines = imagePlaneModule.columnCosines,
      rowPixelSpacing = imagePlaneModule.rowPixelSpacing,
      columnPixelSpacing = imagePlaneModule.columnPixelSpacing;
    var _iterator2 = _createForOfIteratorHelper(bufferIndices),
      _step2;
    try {
      for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
        var bufferIndex = _step2.value;
        var y = Math.floor(bufferIndex / multiframe.Rows);
        var x = bufferIndex % multiframe.Rows;

        // Image coordinates
        xAcc += x;
        yAcc += y;
        zAcc += z;

        // Calculate world coordinates
        // P(world) = P(image) * IOP * spacing + IPP
        var worldX = imagePositionPatient[0] + x * rowCosines[0] * columnPixelSpacing + y * columnCosines[0] * rowPixelSpacing;
        var worldY = imagePositionPatient[1] + x * rowCosines[1] * columnPixelSpacing + y * columnCosines[1] * rowPixelSpacing;
        var worldZ = imagePositionPatient[2] + x * rowCosines[2] * columnPixelSpacing + y * columnCosines[2] * rowPixelSpacing;
        worldXAcc += worldX;
        worldYAcc += worldY;
        worldZAcc += worldZ;
        count++;
      }
    } catch (err) {
      _iterator2.e(err);
    } finally {
      _iterator2.f();
    }
  }
  return {
    image: {
      x: Math.floor(xAcc / count),
      y: Math.floor(yAcc / count),
      z: Math.floor(zAcc / count)
    },
    world: {
      x: worldXAcc / count,
      y: worldYAcc / count,
      z: worldZAcc / count
    },
    count: count
  };
}
var Segmentation = {
  generateSegmentation: generateSegmentation,
  generateToolState: generateToolState,
  fillSegmentation: fillSegmentation
};

export { Segmentation as default, fillSegmentation, generateSegmentation, generateToolState };
