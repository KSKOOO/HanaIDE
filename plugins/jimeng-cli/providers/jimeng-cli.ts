export const id = "jimeng-cli";
export const displayName = "即梦 CLI";
export const authType = "none";

const IMAGE_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
const VIDEO_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"];

const NO_REFERENCE_IMAGES = { referenceImages: { min: 0, max: 0 } };

function referenceImages({ min = 1, max = undefined }: any = {}) {
  return {
    referenceImages: {
      min,
      ...(max !== undefined ? { max } : {}),
    },
  };
}

function imageMode(id, label, inputLimits) {
  return {
    id,
    label,
    parameterSchema: {
      type: "object",
      properties: {
        ratio: { type: "string", enum: IMAGE_RATIOS, default: "3:2" },
        resolution: { type: "string", enum: ["2k", "4k"], default: "4k" },
      },
    },
    defaults: { ratio: "3:2", resolution: "4k" },
    inputLimits,
  };
}

function textVideoSchema(resolutions = ["720p"]) {
  return {
    type: "object",
    properties: {
      ratio: { type: "string", enum: VIDEO_RATIOS, default: "16:9" },
      duration: { type: "integer", minimum: 4, maximum: 15, default: 5 },
      video_resolution: { type: "string", enum: resolutions, default: "720p" },
    },
  };
}

function imageVideoSchema({ min, max, resolutions = ["720p"] }) {
  return {
    type: "object",
    properties: {
      duration: { type: "integer", minimum: min, maximum: max, default: 5 },
      video_resolution: { type: "string", enum: resolutions, default: "720p" },
    },
  };
}

function text2videoMode(resolutions = ["720p"]) {
  return {
    id: "text2video",
    label: "文生视频",
    parameterSchema: textVideoSchema(resolutions),
    defaults: { duration: 5, ratio: "16:9", video_resolution: "720p" },
    inputLimits: NO_REFERENCE_IMAGES,
  };
}

function image2videoMode({ min = 4, max = 15, resolutions = ["720p"] } = {}) {
  return {
    id: "image2video",
    label: "单图生视频",
    parameterSchema: imageVideoSchema({ min, max, resolutions }),
    defaults: { duration: 5, video_resolution: "720p" },
    inputLimits: referenceImages({ max: 1 }),
  };
}

function seedanceModel(id, displayName, resolutions = ["720p"]) {
  return {
    id,
    displayName,
    protocolId: "jimeng-cli-videos",
    inputs: ["text", "image"],
    outputs: ["video"],
    supportsAsync: true,
    modes: [
      text2videoMode(resolutions),
      image2videoMode({ min: 4, max: 15, resolutions }),
    ],
    ratios: VIDEO_RATIOS,
    resolutions,
    duration: { min: 4, max: 15 },
  };
}

function imageOnlyVideoModel(id, displayName, min, max) {
  return {
    id,
    displayName,
    protocolId: "jimeng-cli-videos",
    inputs: ["image"],
    outputs: ["video"],
    supportsAsync: true,
    modes: [image2videoMode({ min, max })],
    resolutions: ["720p"],
    duration: { min, max },
  };
}

export const capabilities = {
  chat: {
    projection: "none",
    runtimeProviderId: "jimeng-cli",
    displayProviderId: "jimeng-cli",
  },
  media: {
    imageGeneration: {
      defaultModelId: "jimeng-image-5.0",
      models: [
        {
          id: "jimeng-image-5.0",
          displayName: "即梦图片 5.0",
          protocolId: "jimeng-cli-images",
          inputs: ["text", "image"],
          outputs: ["image"],
          supportsEdit: true,
          modes: [
            imageMode("text2image", "文生图", NO_REFERENCE_IMAGES),
            imageMode("image2image", "图生图", referenceImages()),
          ],
          ratios: IMAGE_RATIOS,
          resolutions: ["2k", "4k"],
        },
      ],
    },
    videoGeneration: {
      defaultModelId: "seedance2.0fast",
      models: [
        seedanceModel("seedance2.0fast", "Seedance 2.0 Fast"),
        seedanceModel("seedance2.0", "Seedance 2.0"),
        seedanceModel("seedance2.0fast_vip", "Seedance 2.0 Fast VIP"),
        seedanceModel("seedance2.0_vip", "Seedance 2.0 VIP", ["720p", "1080p"]),
        imageOnlyVideoModel("3.0", "即梦视频 3.0", 3, 10),
        imageOnlyVideoModel("3.0fast", "即梦视频 3.0 Fast", 3, 10),
        imageOnlyVideoModel("3.0pro", "即梦视频 3.0 Pro", 3, 10),
        imageOnlyVideoModel("3.5pro", "即梦视频 3.5 Pro", 4, 12),
      ],
    },
  },
};
