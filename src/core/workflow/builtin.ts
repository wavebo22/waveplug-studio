// WavePlug's built-in workflows: the six the plugin is tuned for (局部重绘/移除, 扩图, 文生图, 放大,
// 融图, 抠图), bindings included, matching the models in WavePlug's ComfyUI pack (comfyui\ in the
// install folder). A panel with no workflows starts with them; 导入工作流 › WavePlug 内置工作流
// adds back any that were deleted. Generated from the author's tuned profiles (2026-11-17).

import type { Profile } from "./profile.ts";

export const BUILTIN_PROFILES: readonly Profile[] = [
 {
  "schema": "waveplug.profile.v1",
  "id": "pmvvhvvmscwm3",
  "name": "Qwen-2.1-移除、局部重绘_PS插件连接本地comfyui专用_本机适配",
  "taskType": "inpaint",
  "createdAt": 1794900000000,
  "updatedAt": 1794900000000,
  "api": {
   "8": {
    "class_type": "UNETLoader",
    "inputs": {
     "unet_name": "Qwen\\qwen_image_2.1_turbo_int8_convrot.safetensors",
     "weight_dtype": "default"
    },
    "_meta": {
     "title": "UNETLoader"
    }
   },
   "9": {
    "class_type": "CLIPLoader",
    "inputs": {
     "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
     "type": "qwen_image",
     "device": "default"
    },
    "_meta": {
     "title": "CLIPLoader"
    }
   },
   "10": {
    "class_type": "VAELoader",
    "inputs": {
     "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
    },
    "_meta": {
     "title": "VAELoader"
    }
   },
   "22": {
    "class_type": "DF_Text_Box",
    "inputs": {
     "Text": ""
    },
    "_meta": {
     "title": "# 2.提示词"
    }
   },
   "38": {
    "class_type": "SaveImage",
    "inputs": {
     "filename_prefix": "ComfyUI",
     "images": [
      "262",
      0
     ]
    },
    "_meta": {
     "title": "SaveImage"
    }
   },
   "118": {
    "class_type": "TextEncodeQwenImage21GH",
    "inputs": {
     "prompt": "移除图像中的绿色区域",
     "negative_prompt": "",
     "latent_width": [
      "209",
      1
     ],
     "latent_height": [
      "209",
      2
     ],
     "mode": "填充",
     "ref_image_size": "自动",
     "clip": [
      "9",
      0
     ],
     "vae": [
      "10",
      0
     ],
     "image_01": [
      "209",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21GH"
    }
   },
   "179": {
    "class_type": "QwenImagePromptOptimizer",
    "inputs": {
     "用户提示词": [
      "22",
      0
     ],
     "文生图模型": "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf",
     "图生图模型": "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf",
     "视觉模型": "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf",
     "输出语言": "自动",
     "透明背景": false,
     "种子值": 666,
     "种子模式": "固定",
     "卸载模型": "自动",
     "图像_01": [
      "250",
      0
     ]
    },
    "_meta": {
     "title": "QwenImagePromptOptimizer"
    }
   },
   "201": {
    "class_type": "GH_MaskCropV2",
    "inputs": {
     "遮罩填充": true,
     "扩展系数上": 1.3,
     "扩展系数下": 1.4,
     "扩展系数左": 1.4,
     "扩展系数右": 1.4,
     "输出尺寸": "原像素",
     "自定义宽": 1024,
     "自定义高": 1024,
     "倍数取整": 0,
     "图像": [
      "303",
      0
     ],
     "遮罩": [
      "303",
      1
     ]
    },
    "_meta": {
     "title": "GH_MaskCropV2"
    }
   },
   "204": {
    "class_type": "GulfSeaImageMergeMask",
    "inputs": {
     "透明度": 0.4000000000000001,
     "遮罩扩展": 0,
     "模糊半径": 0,
     "匹配图像大小": true,
     "背景图": [
      "201",
      1
     ],
     "覆盖图": [
      "205",
      0
     ],
     "遮罩": [
      "201",
      2
     ]
    },
    "_meta": {
     "title": "GulfSeaImageMergeMask"
    }
   },
   "205": {
    "class_type": "LayerUtility: ColorImage",
    "inputs": {
     "width": 512,
     "height": 512,
     "color": "#00ff00"
    },
    "_meta": {
     "title": "LayerUtility: ColorImage"
    }
   },
   "207": {
    "class_type": "图像缩放范围孤海",
    "inputs": {
     "限制模式": "长边",
     "最小尺寸": 768,
     "最大尺寸": [
      "304",
      0
     ],
     "整除数": 32,
     "图像": [
      "204",
      0
     ]
    },
    "_meta": {
     "title": "图像缩放范围孤海"
    }
   },
   "208": {
    "class_type": "Get Image Size",
    "inputs": {
     "image": [
      "207",
      0
     ]
    },
    "_meta": {
     "title": "Get Image Size"
    }
   },
   "209": {
    "class_type": "图像缩放V2_孤海",
    "inputs": {
     "宽度": [
      "208",
      0
     ],
     "高度": [
      "208",
      1
     ],
     "缩放方法": "自定义宽高",
     "将边缩放到": 1024,
     "缩放插值": "Lanczos",
     "缩放模式": "拉伸",
     "固定方向": "居中",
     "执行条件": "总是",
     "填充颜色": "#364254",
     "整除数": 0,
     "图像": [
      "204",
      0
     ],
     "遮罩": [
      "201",
      2
     ]
    },
    "_meta": {
     "title": "图像缩放V2_孤海"
    }
   },
   "212": {
    "class_type": "GH_CropRestore",
    "inputs": {
     "遮罩扩展百分比": 4,
     "遮罩羽化百分比": 5,
     "颜色还原强度": 1,
     "接缝": [
      "201",
      0
     ],
     "裁剪图像": [
      "272",
      0
     ]
    },
    "_meta": {
     "title": "GH_CropRestore"
    }
   },
   "217": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\Qwen2.1_万物移除Remove_GH.safetensors",
     "strength_model": 1,
     "model": [
      "8",
      0
     ]
    },
    "_meta": {
     "title": "LoraLoaderModelOnly"
    }
   },
   "247": {
    "class_type": "图像缩放范围孤海",
    "inputs": {
     "限制模式": "长边",
     "最小尺寸": 768,
     "最大尺寸": [
      "304",
      0
     ],
     "整除数": 32,
     "图像": [
      "249",
      1
     ]
    },
    "_meta": {
     "title": "图像缩放范围孤海"
    }
   },
   "248": {
    "class_type": "Get Image Size",
    "inputs": {
     "image": [
      "247",
      0
     ]
    },
    "_meta": {
     "title": "Get Image Size"
    }
   },
   "249": {
    "class_type": "GH_MaskCropV2",
    "inputs": {
     "遮罩填充": true,
     "扩展系数上": 1.3,
     "扩展系数下": 1.4,
     "扩展系数左": 1.4,
     "扩展系数右": 1.4,
     "输出尺寸": "原像素",
     "自定义宽": 1024,
     "自定义高": 1024,
     "倍数取整": 0,
     "图像": [
      "303",
      0
     ],
     "遮罩": [
      "303",
      1
     ]
    },
    "_meta": {
     "title": "GH_MaskCropV2"
    }
   },
   "250": {
    "class_type": "图像缩放V2_孤海",
    "inputs": {
     "宽度": [
      "248",
      0
     ],
     "高度": [
      "248",
      1
     ],
     "缩放方法": "自定义宽高",
     "将边缩放到": 1024,
     "缩放插值": "Lanczos",
     "缩放模式": "拉伸",
     "固定方向": "居中",
     "执行条件": "总是",
     "填充颜色": "#364254",
     "整除数": 0,
     "图像": [
      "249",
      1
     ],
     "遮罩": [
      "249",
      2
     ]
    },
    "_meta": {
     "title": "图像缩放V2_孤海"
    }
   },
   "252": {
    "class_type": "GH_CropRestore",
    "inputs": {
     "遮罩扩展百分比": 4,
     "遮罩羽化百分比": 5,
     "颜色还原强度": 1,
     "接缝": [
      "249",
      0
     ],
     "裁剪图像": [
      "256",
      0
     ]
    },
    "_meta": {
     "title": "GH_CropRestore"
    }
   },
   "255": {
    "class_type": "TextEncodeQwenImage21GH",
    "inputs": {
     "prompt": [
      "305",
      0
     ],
     "negative_prompt": "",
     "latent_width": [
      "250",
      1
     ],
     "latent_height": [
      "250",
      2
     ],
     "mode": "填充",
     "ref_image_size": "自动",
     "clip": [
      "9",
      0
     ],
     "vae": [
      "10",
      0
     ],
     "image_01": [
      "250",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21GH"
    }
   },
   "256": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "274",
      0
     ],
     "vae": [
      "10",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "258": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\Qwen2.1 一致性无偏移_GH_V1.0.safetensors",
     "strength_model": [
      "307",
      0
     ],
     "model": [
      "8",
      0
     ]
    },
    "_meta": {
     "title": "LoraLoaderModelOnly"
    }
   },
   "260": {
    "class_type": "GoohaiAnyExists",
    "inputs": {
     "Any": [
      "22",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiAnyExists"
    }
   },
   "262": {
    "class_type": "easy ifElse",
    "inputs": {
     "boolean": [
      "260",
      1
     ],
     "on_true": [
      "252",
      0
     ],
     "on_false": [
      "212",
      0
     ]
    },
    "_meta": {
     "title": "easy ifElse"
    }
   },
   "267": {
    "class_type": "RandomNoise",
    "inputs": {
     "noise_seed": 73987074229914
    },
    "_meta": {
     "title": "RandomNoise"
    }
   },
   "268": {
    "class_type": "KSamplerSelect",
    "inputs": {
     "sampler_name": "euler"
    },
    "_meta": {
     "title": "KSamplerSelect"
    }
   },
   "269": {
    "class_type": "BasicGuider",
    "inputs": {
     "model": [
      "217",
      0
     ],
     "conditioning": [
      "118",
      0
     ]
    },
    "_meta": {
     "title": "BasicGuider"
    }
   },
   "270": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
     "noise": [
      "267",
      0
     ],
     "guider": [
      "269",
      0
     ],
     "sampler": [
      "268",
      0
     ],
     "sigmas": [
      "271",
      0
     ],
     "latent_image": [
      "118",
      2
     ]
    },
    "_meta": {
     "title": "SamplerCustomAdvanced"
    }
   },
   "271": {
    "class_type": "ManualSigmas",
    "inputs": {
     "sigmas": "1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.150000,0"
    },
    "_meta": {
     "title": "ManualSigmas"
    }
   },
   "272": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "270",
      0
     ],
     "vae": [
      "10",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "274": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
     "noise": [
      "267",
      0
     ],
     "guider": [
      "275",
      0
     ],
     "sampler": [
      "268",
      0
     ],
     "sigmas": [
      "271",
      0
     ],
     "latent_image": [
      "255",
      2
     ]
    },
    "_meta": {
     "title": "SamplerCustomAdvanced"
    }
   },
   "275": {
    "class_type": "BasicGuider",
    "inputs": {
     "model": [
      "258",
      0
     ],
     "conditioning": [
      "255",
      0
     ]
    },
    "_meta": {
     "title": "BasicGuider"
    }
   },
   "277": {
    "class_type": "GoohaiDisplayAny",
    "inputs": {
     "gh_input_type": "STRING",
     "Any": [
      "179",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiDisplayAny"
    }
   },
   "303": {
    "class_type": "LoadImage",
    "inputs": {
     "image": "0cfe204a2dbb62061b50a6ee469d7206923cf4135efd71fc8b474752baf4d309.png",
     "upload": "image"
    },
    "_meta": {
     "title": "# 1.加载图像"
    }
   },
   "304": {
    "class_type": "easy int",
    "inputs": {
     "value": 2048
    },
    "_meta": {
     "title": "# 4.最大采样尺寸（长边）"
    }
   },
   "305": {
    "class_type": "easy ifElse",
    "inputs": {
     "boolean": [
      "306",
      0
     ],
     "on_true": [
      "277",
      0
     ],
     "on_false": [
      "22",
      0
     ]
    },
    "_meta": {
     "title": "easy ifElse"
    }
   },
   "306": {
    "class_type": "easy boolean",
    "inputs": {
     "value": true
    },
    "_meta": {
     "title": "# 3.提示词优化"
    }
   },
   "307": {
    "class_type": "easy float",
    "inputs": {
     "value": 0.66
    },
    "_meta": {
     "title": "# 5.一致性强度"
    }
   }
  },
  "bindings": [
   {
    "role": "output",
    "nodeId": "38",
    "input": "images",
    "classType": "SaveImage",
    "title": "SaveImage",
    "imageIndex": 0
   },
   {
    "role": "image",
    "nodeId": "303",
    "input": "image",
    "classType": "LoadImage",
    "title": "# 1.加载图像",
    "encoding": "rgba-alpha-mask"
   },
   {
    "role": "prompt",
    "nodeId": "22",
    "input": "Text",
    "classType": "DF_Text_Box",
    "title": "# 2.提示词"
   },
   {
    "role": "seed",
    "nodeId": "267",
    "input": "noise_seed",
    "classType": "RandomNoise",
    "title": "RandomNoise"
   },
   {
    "role": "param",
    "nodeId": "304",
    "input": "value",
    "classType": "easy int",
    "title": "# 4.最大采样尺寸（长边）",
    "label": "最大采样尺寸（长边）"
   },
   {
    "role": "param",
    "nodeId": "306",
    "input": "value",
    "classType": "easy boolean",
    "title": "# 3.提示词优化",
    "label": "提示词优化"
   },
   {
    "role": "param",
    "nodeId": "307",
    "input": "value",
    "classType": "easy float",
    "title": "# 5.一致性强度",
    "label": "一致性强度"
   }
  ],
  "options": {
   "allowEmptyPrompt": true,
   "sendScope": "crop",
   "cropMargin": 1,
   "cropDefault": true,
   "localMask": {
    "enabled": true,
    "links": [
     {
      "nodeId": "118",
      "input": "mask",
      "from": [
       "209",
       3
      ]
     },
     {
      "nodeId": "255",
      "input": "mask",
      "from": [
       "250",
       3
      ]
     }
    ]
   },
   "refSlots": {
    "nodes": [
     {
      "nodeId": "118",
      "inputs": [
       "image_02",
       "image_03",
       "image_04",
       "image_05",
       "image_06",
       "image_07",
       "image_08",
       "image_09",
       "image_10"
      ]
     },
     {
      "nodeId": "255",
      "inputs": [
       "image_02",
       "image_03",
       "image_04",
       "image_05",
       "image_06",
       "image_07",
       "image_08",
       "image_09",
       "image_10"
      ]
     }
    ]
   }
  },
  "source": {
   "kind": "builtin"
  }
 },
 {
  "schema": "waveplug.profile.v1",
  "id": "pmvwvh1mjrm80",
  "name": "Qwen Image 2.1 扩图",
  "taskType": "outpaint",
  "createdAt": 1794900000000,
  "updatedAt": 1794900000000,
  "api": {
   "1": {
    "class_type": "LoadImageGoohai",
    "inputs": {
     "image": "粉发少女的未来通讯耳机肖像 (1).png [input]",
     "保留透明通道": false
    },
    "_meta": {
     "title": "LoadImageGoohai"
    }
   },
   "2": {
    "class_type": "DF_Text_Box",
    "inputs": {
     "Text": "银色全身紧身衣，"
    },
    "_meta": {
     "title": "补充提示词"
    }
   },
   "5": {
    "class_type": "图像缩放V2_孤海",
    "inputs": {
     "宽度": 512,
     "高度": 512,
     "缩放方法": "按长边等比例",
     "将边缩放到": [
      "28",
      0
     ],
     "缩放插值": "Lanczos",
     "缩放模式": "拉伸",
     "固定方向": "居中",
     "执行条件": "总是",
     "填充颜色": "#808080",
     "整除数": 32,
     "图像": [
      "24",
      1
     ]
    },
    "_meta": {
     "title": "图像缩放V2_孤海"
    }
   },
   "7": {
    "class_type": "TextEncodeQwenImage21GH",
    "inputs": {
     "prompt": [
      "32",
      0
     ],
     "negative_prompt": "",
     "latent_width": [
      "5",
      1
     ],
     "latent_height": [
      "5",
      2
     ],
     "mode": "填充",
     "ref_image_size": "自动",
     "clip": [
      "8",
      0
     ],
     "vae": [
      "9",
      0
     ],
     "image_01": [
      "5",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21GH"
    }
   },
   "8": {
    "class_type": "CLIPLoader",
    "inputs": {
     "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
     "type": "qwen_image",
     "device": "default"
    },
    "_meta": {
     "title": "CLIPLoader"
    }
   },
   "9": {
    "class_type": "VAELoader",
    "inputs": {
     "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
    },
    "_meta": {
     "title": "VAELoader"
    }
   },
   "14": {
    "class_type": "UNETLoader",
    "inputs": {
     "unet_name": "Qwen\\qwen_image_2.1_turbo_int8_convrot.safetensors",
     "weight_dtype": "default"
    },
    "_meta": {
     "title": "UNETLoader"
    }
   },
   "15": {
    "class_type": "KSamplerSelect",
    "inputs": {
     "sampler_name": "euler"
    },
    "_meta": {
     "title": "KSamplerSelect"
    }
   },
   "16": {
    "class_type": "ManualSigmas",
    "inputs": {
     "sigmas": "1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.150000, 0"
    },
    "_meta": {
     "title": "ManualSigmas"
    }
   },
   "17": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\Qwen2.1_扩图_GH_3750-8cea94388658.safetensors",
     "strength_model": 0.7,
     "model": [
      "14",
      0
     ]
    },
    "_meta": {
     "title": "LoraLoaderModelOnly"
    }
   },
   "18": {
    "class_type": "RandomNoise",
    "inputs": {
     "noise_seed": 214568762199243
    },
    "_meta": {
     "title": "RandomNoise"
    }
   },
   "19": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
     "noise": [
      "18",
      0
     ],
     "guider": [
      "20",
      0
     ],
     "sampler": [
      "15",
      0
     ],
     "sigmas": [
      "16",
      0
     ],
     "latent_image": [
      "7",
      2
     ]
    },
    "_meta": {
     "title": "SamplerCustomAdvanced"
    }
   },
   "20": {
    "class_type": "BasicGuider",
    "inputs": {
     "model": [
      "17",
      0
     ],
     "conditioning": [
      "7",
      0
     ]
    },
    "_meta": {
     "title": "BasicGuider"
    }
   },
   "21": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "19",
      0
     ],
     "vae": [
      "9",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "23": {
    "class_type": "Image Comparer (rgthree)",
    "inputs": {
     "image_a": [
      "25",
      0
     ],
     "image_b": [
      "48",
      0
     ]
    },
    "_meta": {
     "title": "Image Comparer (rgthree)"
    }
   },
   "24": {
    "class_type": "GH_MaskCropV2",
    "inputs": {
     "遮罩填充": false,
     "扩展系数上": [
      "39",
      1
     ],
     "扩展系数下": [
      "39",
      1
     ],
     "扩展系数左": [
      "39",
      3
     ],
     "扩展系数右": [
      "39",
      3
     ],
     "输出尺寸": "原像素",
     "自定义宽": 1024,
     "自定义高": 1024,
     "倍数取整": 0,
     "图像": [
      "48",
      0
     ],
     "遮罩": [
      "48",
      1
     ]
    },
    "_meta": {
     "title": "GH_MaskCropV2"
    }
   },
   "25": {
    "class_type": "GH_CropRestore",
    "inputs": {
     "遮罩扩展百分比": 3,
     "遮罩羽化百分比": 3,
     "颜色还原强度": 1,
     "接缝": [
      "24",
      0
     ],
     "裁剪图像": [
      "21",
      0
     ]
    },
    "_meta": {
     "title": "GH_CropRestore"
    }
   },
   "27": {
    "class_type": "GoohaiUniversalSlider",
    "inputs": {
     "值": 2048
    },
    "_meta": {
     "title": "最大采样尺寸（长边）"
    }
   },
   "28": {
    "class_type": "数学运算_孤海",
    "inputs": {
     "值1": "min(max(1024,b),a)",
     "值2": "",
     "a": [
      "27",
      0
     ],
     "b": [
      "30",
      0
     ]
    },
    "_meta": {
     "title": "数学运算_孤海"
    }
   },
   "30": {
    "class_type": "长边短边",
    "inputs": {
     "图像": [
      "24",
      1
     ]
    },
    "_meta": {
     "title": "长边短边"
    }
   },
   "32": {
    "class_type": "CR Text Concatenate",
    "inputs": {
     "separator": "",
     "text1": [
      "33",
      0
     ],
     "text2": [
      "2",
      0
     ]
    },
    "_meta": {
     "title": "文本联结"
    }
   },
   "33": {
    "class_type": "easy string",
    "inputs": {
     "value": "移除图像中的灰色区域，无缝自然延展为完整图像。"
    },
    "_meta": {
     "title": "easy string"
    }
   },
   "39": {
    "class_type": "数学运算_孤海",
    "inputs": {
     "值1": "1.0 if b==d else (2/3*(b-d))/min(c,d)+1.0",
     "值2": "1.0 if a==c else (2/3*(a-c))/min(c,d)+1.0",
     "a": [
      "40",
      1
     ],
     "b": [
      "40",
      2
     ],
     "c": [
      "40",
      3
     ],
     "d": [
      "40",
      4
     ]
    },
    "_meta": {
     "title": "数学运算_孤海"
    }
   },
   "40": {
    "class_type": "孤海遮罩分析",
    "inputs": {
     "上扩百分比": 0,
     "下扩百分比": 0,
     "左扩百分比": 0,
     "右扩百分比": 0,
     "遮罩": [
      "48",
      1
     ]
    },
    "_meta": {
     "title": "孤海遮罩分析"
    }
   },
   "46": {
    "class_type": "SaveImage",
    "inputs": {
     "filename_prefix": "ComfyUI",
     "images": [
      "25",
      0
     ]
    },
    "_meta": {
     "title": "SaveImage"
    }
   },
   "48": {
    "class_type": "孤海外补画板可视化",
    "inputs": {
     "单位": "百分比",
     "左": 14,
     "右": 19,
     "上": 0,
     "下": 374,
     "最大输出长边": 5120,
     "整除数": 0,
     "外补颜色": "#808080",
     "gh_visual_ratio": "自由比例",
     "gh_visual_layout": "{\"signature\":[1491,1312,\"百分比\",14,19,0,374],\"pads\":[208,283,0,4909]}",
     "图像": [
      "1",
      0
     ],
     "遮罩": [
      "1",
      1
     ]
    },
    "_meta": {
     "title": "孤海外补画板可视化"
    }
   }
  },
  "bindings": [
   {
    "role": "output",
    "nodeId": "46",
    "input": "images",
    "classType": "SaveImage",
    "title": "SaveImage",
    "imageIndex": 0
   },
   {
    "role": "image",
    "nodeId": "1",
    "input": "image",
    "classType": "LoadImageGoohai",
    "title": "LoadImageGoohai",
    "encoding": "rgb"
   },
   {
    "role": "pad",
    "nodeId": "48",
    "input": "左",
    "classType": "孤海外补画板可视化",
    "title": "孤海外补画板可视化",
    "side": "left",
    "label": "扩展 left"
   },
   {
    "role": "pad",
    "nodeId": "48",
    "input": "右",
    "classType": "孤海外补画板可视化",
    "title": "孤海外补画板可视化",
    "side": "right",
    "label": "扩展 right"
   },
   {
    "role": "pad",
    "nodeId": "48",
    "input": "上",
    "classType": "孤海外补画板可视化",
    "title": "孤海外补画板可视化",
    "side": "top",
    "label": "扩展 top"
   },
   {
    "role": "pad",
    "nodeId": "48",
    "input": "下",
    "classType": "孤海外补画板可视化",
    "title": "孤海外补画板可视化",
    "side": "bottom",
    "label": "扩展 bottom"
   },
   {
    "role": "prompt",
    "nodeId": "2",
    "input": "Text",
    "classType": "DF_Text_Box",
    "title": "补充提示词"
   },
   {
    "role": "seed",
    "nodeId": "18",
    "input": "noise_seed",
    "classType": "RandomNoise",
    "title": "RandomNoise"
   }
  ],
  "options": {
   "allowEmptyPrompt": true,
   "sendScope": "crop",
   "cropMargin": 1,
   "cropDefault": true,
   "outpaint": {
    "nodeId": "48",
    "unit": {
     "input": "单位",
     "value": "像素"
    },
    "ratio": {
     "input": "gh_visual_ratio",
     "value": "自由比例"
    },
    "layout": {
     "input": "gh_visual_layout"
    },
    "maxPad": 3000
   },
   "refSlots": {
    "nodes": [
     {
      "nodeId": "7",
      "inputs": [
       "image_02",
       "image_03",
       "image_04",
       "image_05",
       "image_06",
       "image_07",
       "image_08",
       "image_09",
       "image_10"
      ]
     }
    ]
   }
  },
  "source": {
   "kind": "builtin"
  }
 },
 {
  "schema": "waveplug.profile.v1",
  "id": "pmvwxb95bis0s",
  "name": "Qwen Image 2.1 文生图",
  "taskType": "txt2img",
  "createdAt": 1794900000000,
  "updatedAt": 1794900000000,
  "api": {
   "8": {
    "class_type": "UNETLoader",
    "inputs": {
     "unet_name": "Qwen\\qwen_image_2.1_int8_convrot.safetensors",
     "weight_dtype": "default"
    },
    "_meta": {
     "title": "UNETLoader"
    }
   },
   "9": {
    "class_type": "CLIPLoader",
    "inputs": {
     "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
     "type": "qwen_image",
     "device": "default"
    },
    "_meta": {
     "title": "CLIPLoader"
    }
   },
   "10": {
    "class_type": "VAELoader",
    "inputs": {
     "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
    },
    "_meta": {
     "title": "VAELoader"
    }
   },
   "12": {
    "class_type": "KSampler",
    "inputs": {
     "seed": 901118096922719,
     "steps": 30,
     "cfg": 1,
     "sampler_name": "euler",
     "scheduler": "simple",
     "denoise": 1,
     "model": [
      "75",
      0
     ],
     "positive": [
      "118",
      0
     ],
     "negative": [
      "118",
      1
     ],
     "latent_image": [
      "118",
      2
     ]
    },
    "_meta": {
     "title": "KSampler"
    }
   },
   "16": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "12",
      0
     ],
     "vae": [
      "10",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "22": {
    "class_type": "DF_Text_Box",
    "inputs": {
     "Text": "奥特曼大战蝙蝠侠"
    },
    "_meta": {
     "title": "提示词"
    }
   },
   "38": {
    "class_type": "SaveImage",
    "inputs": {
     "filename_prefix": "ComfyUI",
     "images": [
      "124",
      0
     ]
    },
    "_meta": {
     "title": "SaveImage"
    }
   },
   "39": {
    "class_type": "GoohaiRatioAndResolution",
    "inputs": {
     "比例": "原始比例",
     "模式": "总像素",
     "固定边像素": 1536,
     "百万像素": 2,
     "长边最小": 1024,
     "长边最大": 1536,
     "自定宽度": 32,
     "自定高度": 1024,
     "倍数取整": 32,
     "图像": [
      "193",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiRatioAndResolution"
    }
   },
   "75": {
    "class_type": "QwenImage21SpectrumT8",
    "inputs": {
     "history": 4,
     "degree": 2,
     "ridge": 0.01,
     "guard_threshold": 0.25,
     "start_percent": 0.15,
     "end_percent": 0.85,
     "max_consecutive_hits": 1,
     "cache_device": "cpu",
     "max_cache_mb": 1024,
     "threshold_mode": "constant",
     "split_ratio": 0.5,
     "late_threshold": 0.08,
     "model": [
      "165",
      0
     ]
    },
    "_meta": {
     "title": "QwenImage21SpectrumT8"
    }
   },
   "79": {
    "class_type": "QwenImage21SageAttentionT8",
    "inputs": {
     "backend_mode": "sage_kitchen",
     "model": [
      "196",
      0
     ]
    },
    "_meta": {
     "title": "QwenImage21SageAttentionT8"
    }
   },
   "118": {
    "class_type": "TextEncodeQwenImage21GH",
    "inputs": {
     "prompt": [
      "195",
      0
     ],
     "negative_prompt": "",
     "latent_width": [
      "39",
      1
     ],
     "latent_height": [
      "39",
      2
     ],
     "mode": "填充",
     "ref_image_size": "自动",
     "clip": [
      "9",
      0
     ],
     "vae": [
      "10",
      0
     ],
     "mask": [
      "174",
      0
     ],
     "image_01": [
      "170",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21GH"
    }
   },
   "124": {
    "class_type": "RestoreQwenImage21GH",
    "inputs": {
     "image": [
      "16",
      0
     ],
     "info": [
      "118",
      3
     ]
    },
    "_meta": {
     "title": "RestoreQwenImage21GH"
    }
   },
   "165": {
    "class_type": "QwenImage21BlockCacheT8",
    "inputs": {
     "residual_diff_threshold": 0.08,
     "start_percent": 0.1,
     "end_percent": 0.85,
     "max_consecutive_hits": 2,
     "cache_device": "cpu",
     "metric_stride": 8,
     "max_cache_mb": 1024,
     "threshold_mode": "constant",
     "split_ratio": 0.5,
     "late_threshold": 0.03,
     "model": [
      "79",
      0
     ]
    },
    "_meta": {
     "title": "QwenImage21BlockCacheT8"
    }
   },
   "170": {
    "class_type": "GoohaiRouteBlocker",
    "inputs": {
     "是否阻断": [
      "179",
      2
     ],
     "阻断模式": "仅输出空值",
     "any": [
      "193",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiRouteBlocker"
    }
   },
   "174": {
    "class_type": "GoohaiRouteBlocker",
    "inputs": {
     "是否阻断": true,
     "阻断模式": "仅输出空值",
     "any": [
      "193",
      1
     ]
    },
    "_meta": {
     "title": "是否禁用遮罩"
    }
   },
   "179": {
    "class_type": "QwenImagePromptOptimizer",
    "inputs": {
     "用户提示词": [
      "22",
      0
     ],
     "文生图模型": "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf",
     "图生图模型": "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf",
     "视觉模型": "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf",
     "输出语言": "自动",
     "透明背景": false,
     "种子值": 1445299085,
     "种子模式": "随机",
     "卸载模型": "自动",
     "图像_01": [
      "193",
      0
     ]
    },
    "_meta": {
     "title": "QwenImagePromptOptimizer"
    }
   },
   "192": {
    "class_type": "Image Comparer (rgthree)",
    "inputs": {
     "image_a": [
      "124",
      0
     ],
     "image_b": [
      "193",
      0
     ]
    },
    "_meta": {
     "title": "Image Comparer (rgthree)"
    }
   },
   "193": {
    "class_type": "LoadImageGoohai",
    "inputs": {
     "image": "03cd2ee56656496ab5987c54baf22aad.jpeg",
     "保留透明通道": false
    },
    "_meta": {
     "title": "LoadImageGoohai"
    }
   },
   "194": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\Qwen2.1 一致性无偏移_GH_V1.0.safetensors",
     "strength_model": 0.48,
     "model": [
      "8",
      0
     ]
    },
    "_meta": {
     "title": "LoraLoaderModelOnly"
    }
   },
   "195": {
    "class_type": "GoohaiDisplayAny",
    "inputs": {
     "gh_input_type": "STRING",
     "Any": [
      "179",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiDisplayAny"
    }
   },
   "196": {
    "class_type": "easy ifElse",
    "inputs": {
     "boolean": [
      "197",
      1
     ],
     "on_true": [
      "194",
      0
     ],
     "on_false": [
      "8",
      0
     ]
    },
    "_meta": {
     "title": "easy ifElse"
    }
   },
   "197": {
    "class_type": "GoohaiAnyExists",
    "inputs": {
     "Any": [
      "170",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiAnyExists"
    }
   }
  },
  "bindings": [
   {
    "role": "output",
    "nodeId": "38",
    "input": "images",
    "classType": "SaveImage",
    "title": "SaveImage",
    "imageIndex": 0
   },
   {
    "role": "size",
    "nodeId": "39",
    "input": "自定宽度",
    "classType": "GoohaiRatioAndResolution",
    "title": "GoohaiRatioAndResolution",
    "axis": "w",
    "label": "宽度"
   },
   {
    "role": "size",
    "nodeId": "39",
    "input": "自定高度",
    "classType": "GoohaiRatioAndResolution",
    "title": "GoohaiRatioAndResolution",
    "axis": "h",
    "label": "高度"
   },
   {
    "role": "reference",
    "nodeId": "193",
    "input": "image",
    "classType": "LoadImageGoohai",
    "title": "LoadImageGoohai",
    "slot": 1,
    "encoding": "rgb",
    "emptyValue": "无"
   },
   {
    "role": "prompt",
    "nodeId": "22",
    "input": "Text",
    "classType": "DF_Text_Box",
    "title": "提示词"
   },
   {
    "role": "seed",
    "nodeId": "12",
    "input": "seed",
    "classType": "KSampler",
    "title": "KSampler"
   }
  ],
  "options": {
   "allowEmptyPrompt": false,
   "sendScope": "crop",
   "cropMargin": 1,
   "cropDefault": true,
   "txt2img": {
    "forced": [
     {
      "nodeId": "39",
      "input": "比例",
      "value": "自定义宽高"
     }
    ],
    "multiple": 32,
    "max": 10240
   },
   "refSlots": {
    "nodes": [
     {
      "nodeId": "118",
      "inputs": [
       "image_02",
       "image_03",
       "image_04",
       "image_05",
       "image_06",
       "image_07",
       "image_08",
       "image_09",
       "image_10"
      ]
     }
    ]
   }
  },
  "source": {
   "kind": "builtin"
  }
 },
 {
  "schema": "waveplug.profile.v1",
  "id": "pmvxr8sts866o",
  "name": "▶▷VOSR2-图像放大",
  "taskType": "upscale",
  "createdAt": 1794900000000,
  "updatedAt": 1794900000000,
  "api": {
   "1": {
    "class_type": "SaveImage",
    "inputs": {
     "filename_prefix": "VOSR2--%date:yyyyMMddhhmmss%",
     "images": [
      "11",
      0
     ]
    },
    "_meta": {
     "title": "SaveImage"
    }
   },
   "2": {
    "class_type": "LoadImage",
    "inputs": {
     "image": "baba423d1b442023fcb39a62508a63e.jpg",
     "upload": "image"
    },
    "_meta": {
     "title": "LoadImage"
    }
   },
   "3": {
    "class_type": "TESpeedVOSR2Settings",
    "inputs": {
     "quality_profile": "speed",
     "tile_strategy": "auto",
     "tile_size": 512,
     "tile_overlap": 32,
     "vae_tile_size": 1024,
     "vae_tile_overlap": 32,
     "image_batch": 1,
     "frame_batch": 2,
     "dino_batch": 2,
     "temporal_cache": false,
     "cache_threshold": 0.003,
     "cache_refresh": 4,
     "memory_policy": "auto",
     "color_alignment": "wavelet"
    },
    "_meta": {
     "title": "TESpeedVOSR2Settings"
    }
   },
   "4": {
    "class_type": "easy int",
    "inputs": {
     "value": 5
    },
    "_meta": {
     "title": "easy int"
    }
   },
   "11": {
    "class_type": "TESpeedVOSR2Image",
    "inputs": {
     "scale": [
      "4",
      0
     ],
     "seed": 666,
     "model": [
      "12",
      0
     ],
     "images": [
      "2",
      0
     ],
     "settings": [
      "3",
      0
     ]
    },
    "_meta": {
     "title": "TESpeedVOSR2Image"
    }
   },
   "12": {
    "class_type": "TESpeedVOSR2Loader",
    "inputs": {
     "model_bundle": "VOSR2",
     "precision": "auto",
     "memory_policy": "auto",
     "torch_compile": false,
     "vae_encode_amp": false
    },
    "_meta": {
     "title": "TESpeedVOSR2Loader"
    }
   },
   "18": {
    "class_type": "Image Comparer (rgthree)",
    "inputs": {
     "image_a": [
      "2",
      0
     ],
     "image_b": [
      "11",
      0
     ]
    },
    "_meta": {
     "title": "Image Comparer (rgthree)"
    }
   }
  },
  "bindings": [
   {
    "role": "output",
    "nodeId": "1",
    "input": "images",
    "classType": "SaveImage",
    "title": "SaveImage",
    "imageIndex": 0
   },
   {
    "role": "image",
    "nodeId": "2",
    "input": "image",
    "classType": "LoadImage",
    "title": "LoadImage",
    "encoding": "rgb"
   },
   {
    "role": "scale",
    "nodeId": "4",
    "input": "value",
    "classType": "easy int",
    "title": "easy int",
    "label": "放大倍数"
   },
   {
    "role": "seed",
    "nodeId": "11",
    "input": "seed",
    "classType": "TESpeedVOSR2Image",
    "title": "TESpeedVOSR2Image"
   }
  ],
  "options": {
   "allowEmptyPrompt": true,
   "sendScope": "crop",
   "cropMargin": 1,
   "cropDefault": true,
   "upscale": {
    "factors": [
     1,
     2,
     3,
     4
    ]
   }
  },
  "source": {
   "kind": "builtin"
  }
 },
 {
  "schema": "waveplug.profile.v1",
  "id": "pmvydl9o5izpq",
  "name": "Qwen-2.1-融图_Turbo_PS插件专用",
  "taskType": "blend",
  "createdAt": 1794900000000,
  "updatedAt": 1794900000000,
  "api": {
   "8": {
    "class_type": "UNETLoader",
    "inputs": {
     "unet_name": "Qwen\\qwen_image_2.1_turbo_int8_convrot.safetensors",
     "weight_dtype": "default"
    },
    "_meta": {
     "title": "UNETLoader"
    }
   },
   "9": {
    "class_type": "CLIPLoader",
    "inputs": {
     "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
     "type": "qwen_image",
     "device": "default"
    },
    "_meta": {
     "title": "CLIPLoader"
    }
   },
   "10": {
    "class_type": "VAELoader",
    "inputs": {
     "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
    },
    "_meta": {
     "title": "VAELoader"
    }
   },
   "22": {
    "class_type": "DF_Text_Box",
    "inputs": {
     "Text": ""
    },
    "_meta": {
     "title": "# 2.提示词（可留空，留空=默认融图提示词）"
    }
   },
   "38": {
    "class_type": "SaveImage",
    "inputs": {
     "filename_prefix": "ComfyUI",
     "images": [
      "262",
      0
     ]
    },
    "_meta": {
     "title": "SaveImage"
    }
   },
   "118": {
    "class_type": "TextEncodeQwenImage21GH",
    "inputs": {
     "prompt": "移除图像中的绿色区域",
     "negative_prompt": "",
     "latent_width": [
      "209",
      1
     ],
     "latent_height": [
      "209",
      2
     ],
     "mode": "填充",
     "ref_image_size": "自动",
     "clip": [
      "9",
      0
     ],
     "vae": [
      "10",
      0
     ],
     "image_01": [
      "209",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21GH"
    }
   },
   "179": {
    "class_type": "QwenImagePromptOptimizer",
    "inputs": {
     "用户提示词": [
      "310",
      0
     ],
     "文生图模型": "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf",
     "图生图模型": "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf",
     "视觉模型": "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf",
     "输出语言": "自动",
     "透明背景": false,
     "种子值": 666,
     "种子模式": "固定",
     "卸载模型": "自动",
     "图像_01": [
      "250",
      0
     ]
    },
    "_meta": {
     "title": "QwenImagePromptOptimizer"
    }
   },
   "201": {
    "class_type": "GH_MaskCropV2",
    "inputs": {
     "遮罩填充": true,
     "扩展系数上": 1.3,
     "扩展系数下": 1.4,
     "扩展系数左": 1.4,
     "扩展系数右": 1.4,
     "输出尺寸": "原像素",
     "自定义宽": 1024,
     "自定义高": 1024,
     "倍数取整": 0,
     "图像": [
      "303",
      0
     ],
     "遮罩": [
      "303",
      1
     ]
    },
    "_meta": {
     "title": "GH_MaskCropV2"
    }
   },
   "204": {
    "class_type": "GulfSeaImageMergeMask",
    "inputs": {
     "透明度": 0.4000000000000001,
     "遮罩扩展": 0,
     "模糊半径": 0,
     "匹配图像大小": true,
     "背景图": [
      "201",
      1
     ],
     "覆盖图": [
      "205",
      0
     ],
     "遮罩": [
      "201",
      2
     ]
    },
    "_meta": {
     "title": "GulfSeaImageMergeMask"
    }
   },
   "205": {
    "class_type": "LayerUtility: ColorImage",
    "inputs": {
     "width": 512,
     "height": 512,
     "color": "#00ff00"
    },
    "_meta": {
     "title": "LayerUtility: ColorImage"
    }
   },
   "207": {
    "class_type": "图像缩放范围孤海",
    "inputs": {
     "限制模式": "长边",
     "最小尺寸": 768,
     "最大尺寸": [
      "304",
      0
     ],
     "整除数": 32,
     "图像": [
      "204",
      0
     ]
    },
    "_meta": {
     "title": "图像缩放范围孤海"
    }
   },
   "208": {
    "class_type": "Get Image Size",
    "inputs": {
     "image": [
      "207",
      0
     ]
    },
    "_meta": {
     "title": "Get Image Size"
    }
   },
   "209": {
    "class_type": "图像缩放V2_孤海",
    "inputs": {
     "宽度": [
      "208",
      0
     ],
     "高度": [
      "208",
      1
     ],
     "缩放方法": "自定义宽高",
     "将边缩放到": 1024,
     "缩放插值": "Lanczos",
     "缩放模式": "拉伸",
     "固定方向": "居中",
     "执行条件": "总是",
     "填充颜色": "#364254",
     "整除数": 0,
     "图像": [
      "204",
      0
     ],
     "遮罩": [
      "201",
      2
     ]
    },
    "_meta": {
     "title": "图像缩放V2_孤海"
    }
   },
   "212": {
    "class_type": "GH_CropRestore",
    "inputs": {
     "遮罩扩展百分比": 4,
     "遮罩羽化百分比": 5,
     "颜色还原强度": 1,
     "接缝": [
      "201",
      0
     ],
     "裁剪图像": [
      "272",
      0
     ]
    },
    "_meta": {
     "title": "GH_CropRestore"
    }
   },
   "247": {
    "class_type": "图像缩放范围孤海",
    "inputs": {
     "限制模式": "长边",
     "最小尺寸": 768,
     "最大尺寸": [
      "304",
      0
     ],
     "整除数": 32,
     "图像": [
      "249",
      1
     ]
    },
    "_meta": {
     "title": "图像缩放范围孤海"
    }
   },
   "248": {
    "class_type": "Get Image Size",
    "inputs": {
     "image": [
      "247",
      0
     ]
    },
    "_meta": {
     "title": "Get Image Size"
    }
   },
   "249": {
    "class_type": "GH_MaskCropV2",
    "inputs": {
     "遮罩填充": true,
     "扩展系数上": 1.3,
     "扩展系数下": 1.4,
     "扩展系数左": 1.4,
     "扩展系数右": 1.4,
     "输出尺寸": "原像素",
     "自定义宽": 1024,
     "自定义高": 1024,
     "倍数取整": 0,
     "图像": [
      "303",
      0
     ],
     "遮罩": [
      "303",
      1
     ]
    },
    "_meta": {
     "title": "GH_MaskCropV2"
    }
   },
   "250": {
    "class_type": "图像缩放V2_孤海",
    "inputs": {
     "宽度": [
      "248",
      0
     ],
     "高度": [
      "248",
      1
     ],
     "缩放方法": "自定义宽高",
     "将边缩放到": 1024,
     "缩放插值": "Lanczos",
     "缩放模式": "拉伸",
     "固定方向": "居中",
     "执行条件": "总是",
     "填充颜色": "#364254",
     "整除数": 0,
     "图像": [
      "249",
      1
     ],
     "遮罩": [
      "249",
      2
     ]
    },
    "_meta": {
     "title": "图像缩放V2_孤海"
    }
   },
   "252": {
    "class_type": "GH_CropRestore",
    "inputs": {
     "遮罩扩展百分比": 4,
     "遮罩羽化百分比": 5,
     "颜色还原强度": 1,
     "接缝": [
      "249",
      0
     ],
     "裁剪图像": [
      "256",
      0
     ]
    },
    "_meta": {
     "title": "GH_CropRestore"
    }
   },
   "255": {
    "class_type": "TextEncodeQwenImage21GH",
    "inputs": {
     "prompt": [
      "305",
      0
     ],
     "negative_prompt": "",
     "latent_width": [
      "250",
      1
     ],
     "latent_height": [
      "250",
      2
     ],
     "mode": "填充",
     "ref_image_size": "自动",
     "clip": [
      "9",
      0
     ],
     "vae": [
      "10",
      0
     ],
     "image_01": [
      "250",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21GH"
    }
   },
   "256": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "274",
      0
     ],
     "vae": [
      "10",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "258": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\Qwen2.1 一致性无偏移_GH_V1.0.safetensors",
     "strength_model": [
      "307",
      0
     ],
     "model": [
      "308",
      0
     ]
    },
    "_meta": {
     "title": "LoraLoaderModelOnly"
    }
   },
   "260": {
    "class_type": "GoohaiAnyExists",
    "inputs": {
     "Any": [
      "22",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiAnyExists"
    }
   },
   "262": {
    "class_type": "easy ifElse",
    "inputs": {
     "boolean": true,
     "on_true": [
      "252",
      0
     ],
     "on_false": [
      "212",
      0
     ]
    },
    "_meta": {
     "title": "easy ifElse"
    }
   },
   "267": {
    "class_type": "RandomNoise",
    "inputs": {
     "noise_seed": 73987074229914
    },
    "_meta": {
     "title": "RandomNoise"
    }
   },
   "268": {
    "class_type": "KSamplerSelect",
    "inputs": {
     "sampler_name": "euler"
    },
    "_meta": {
     "title": "KSamplerSelect"
    }
   },
   "269": {
    "class_type": "BasicGuider",
    "inputs": {
     "model": [
      "8",
      0
     ],
     "conditioning": [
      "118",
      0
     ]
    },
    "_meta": {
     "title": "BasicGuider"
    }
   },
   "270": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
     "noise": [
      "267",
      0
     ],
     "guider": [
      "269",
      0
     ],
     "sampler": [
      "268",
      0
     ],
     "sigmas": [
      "271",
      0
     ],
     "latent_image": [
      "118",
      2
     ]
    },
    "_meta": {
     "title": "SamplerCustomAdvanced"
    }
   },
   "271": {
    "class_type": "ManualSigmas",
    "inputs": {
     "sigmas": "1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.150000,0"
    },
    "_meta": {
     "title": "ManualSigmas"
    }
   },
   "272": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "270",
      0
     ],
     "vae": [
      "10",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "274": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
     "noise": [
      "267",
      0
     ],
     "guider": [
      "275",
      0
     ],
     "sampler": [
      "268",
      0
     ],
     "sigmas": [
      "271",
      0
     ],
     "latent_image": [
      "255",
      2
     ]
    },
    "_meta": {
     "title": "SamplerCustomAdvanced"
    }
   },
   "275": {
    "class_type": "BasicGuider",
    "inputs": {
     "model": [
      "258",
      0
     ],
     "conditioning": [
      "255",
      0
     ]
    },
    "_meta": {
     "title": "BasicGuider"
    }
   },
   "277": {
    "class_type": "GoohaiDisplayAny",
    "inputs": {
     "gh_input_type": "STRING",
     "Any": [
      "179",
      0
     ]
    },
    "_meta": {
     "title": "GoohaiDisplayAny"
    }
   },
   "303": {
    "class_type": "LoadImage",
    "inputs": {
     "image": "0cfe204a2dbb62061b50a6ee469d7206923cf4135efd71fc8b474752baf4d309.png",
     "upload": "image"
    },
    "_meta": {
     "title": "# 1.加载图像"
    }
   },
   "304": {
    "class_type": "easy int",
    "inputs": {
     "value": 2048
    },
    "_meta": {
     "title": "# 4.最大采样尺寸（长边）"
    }
   },
   "305": {
    "class_type": "easy ifElse",
    "inputs": {
     "boolean": [
      "306",
      0
     ],
     "on_true": [
      "277",
      0
     ],
     "on_false": [
      "310",
      0
     ]
    },
    "_meta": {
     "title": "easy ifElse"
    }
   },
   "306": {
    "class_type": "easy boolean",
    "inputs": {
     "value": true
    },
    "_meta": {
     "title": "# 3.提示词优化"
    }
   },
   "307": {
    "class_type": "easy float",
    "inputs": {
     "value": 0
    },
    "_meta": {
     "title": "# 5.一致性强度（融图建议 0–0.3）"
    }
   },
   "308": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\Qwen2.1_融图_c2-st2000.safetensors",
     "strength_model": 1,
     "model": [
      "8",
      0
     ]
    },
    "_meta": {
     "title": "融图 LoRA（pengyu）"
    }
   },
   "309": {
    "class_type": "DF_Text_Box",
    "inputs": {
     "Text": "pengyu 为产品或物体应用一致的光照，增强高光，前后的空间关系，添加自然的接触阴影，并将其无缝融入背景。"
    },
    "_meta": {
     "title": "默认融图文字（留空时使用）"
    }
   },
   "310": {
    "class_type": "easy ifElse",
    "inputs": {
     "boolean": [
      "260",
      0
     ],
     "on_true": [
      "22",
      0
     ],
     "on_false": [
      "309",
      0
     ]
    },
    "_meta": {
     "title": "有提示词就用，没有就用默认"
    }
   }
  },
  "bindings": [
   {
    "role": "output",
    "nodeId": "38",
    "input": "images",
    "classType": "SaveImage",
    "title": "SaveImage",
    "imageIndex": 0
   },
   {
    "role": "image",
    "nodeId": "303",
    "input": "image",
    "classType": "LoadImage",
    "title": "# 1.加载图像",
    "encoding": "rgba-alpha-mask"
   },
   {
    "role": "prompt",
    "nodeId": "22",
    "input": "Text",
    "classType": "DF_Text_Box",
    "title": "# 2.提示词（可留空，留空=默认融图提示词）"
   },
   {
    "role": "seed",
    "nodeId": "267",
    "input": "noise_seed",
    "classType": "RandomNoise",
    "title": "RandomNoise"
   },
   {
    "role": "param",
    "nodeId": "304",
    "input": "value",
    "classType": "easy int",
    "title": "# 4.最大采样尺寸（长边）",
    "label": "最大采样尺寸（长边）"
   },
   {
    "role": "param",
    "nodeId": "306",
    "input": "value",
    "classType": "easy boolean",
    "title": "# 3.提示词优化",
    "label": "提示词优化"
   },
   {
    "role": "param",
    "nodeId": "307",
    "input": "value",
    "classType": "easy float",
    "title": "# 5.一致性强度（融图建议 0–0.3）",
    "label": "一致性强度（融图建议 0–0.3）"
   }
  ],
  "options": {
   "allowEmptyPrompt": true,
   "sendScope": "crop",
   "cropMargin": 1,
   "cropDefault": true,
   "refSlots": {
    "nodes": [
     {
      "nodeId": "118",
      "inputs": [
       "image_02",
       "image_03",
       "image_04",
       "image_05",
       "image_06",
       "image_07",
       "image_08",
       "image_09",
       "image_10"
      ]
     },
     {
      "nodeId": "255",
      "inputs": [
       "image_02",
       "image_03",
       "image_04",
       "image_05",
       "image_06",
       "image_07",
       "image_08",
       "image_09",
       "image_10"
      ]
     }
    ]
   },
   "localMask": {
    "enabled": true,
    "links": [
     {
      "nodeId": "118",
      "input": "mask",
      "from": [
       "209",
       3
      ]
     },
     {
      "nodeId": "255",
      "input": "mask",
      "from": [
       "250",
       3
      ]
     }
    ]
   }
  },
  "source": {
   "kind": "builtin"
  }
 },
 {
  "schema": "waveplug.profile.v1",
  "id": "pmvyfhd5erlkq",
  "name": "Qwen-2.1-心宝抠图_PS插件专用",
  "taskType": "extract",
  "createdAt": 1794900000000,
  "updatedAt": 1794900000000,
  "api": {
   "475": {
    "class_type": "LoadImage",
    "inputs": {
     "image": "IMG_1459.JPG",
     "upload": "image"
    },
    "_meta": {
     "title": "LoadImage"
    }
   },
   "476": {
    "class_type": "UNETLoader",
    "inputs": {
     "unet_name": "Qwen\\qwen_image_2.1_int8_convrot.safetensors",
     "weight_dtype": "default"
    },
    "_meta": {
     "title": "UNETLoader"
    }
   },
   "477": {
    "class_type": "CLIPLoader",
    "inputs": {
     "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
     "type": "qwen_image",
     "device": "default"
    },
    "_meta": {
     "title": "CLIPLoader"
    }
   },
   "478": {
    "class_type": "VAELoader",
    "inputs": {
     "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
    },
    "_meta": {
     "title": "VAELoader"
    }
   },
   "480": {
    "class_type": "VAEDecode",
    "inputs": {
     "samples": [
      "481",
      0
     ],
     "vae": [
      "478",
      0
     ]
    },
    "_meta": {
     "title": "VAEDecode"
    }
   },
   "481": {
    "class_type": "KSampler",
    "inputs": {
     "seed": 0,
     "steps": 25,
     "cfg": 1,
     "sampler_name": "euler",
     "scheduler": "simple",
     "denoise": 1,
     "model": [
      "483",
      0
     ],
     "positive": [
      "497",
      0
     ],
     "negative": [
      "497",
      1
     ],
     "latent_image": [
      "497",
      2
     ]
    },
    "_meta": {
     "title": "KSampler"
    }
   },
   "483": {
    "class_type": "QwenImage21Cache",
    "inputs": {
     "device": "auto",
     "dtype": "default",
     "model": [
      "649",
      0
     ]
    },
    "_meta": {
     "title": "QwenImage21Cache"
    }
   },
   "487": {
    "class_type": "SaveImage",
    "inputs": {
     "filename_prefix": "抠图/xinbao",
     "images": [
      "480",
      0
     ]
    },
    "_meta": {
     "title": "抠出的物件（透明 PNG）"
    }
   },
   "497": {
    "class_type": "TextEncodeQwenImage21",
    "inputs": {
     "prompt": [
      "664",
      0
     ],
     "negative_prompt": "",
     "resolution": 0,
     "clip": [
      "477",
      0
     ],
     "images.image_1": [
      "532",
      0
     ],
     "vae": [
      "478",
      0
     ]
    },
    "_meta": {
     "title": "TextEncodeQwenImage21"
    }
   },
   "532": {
    "class_type": "ImageScaleToTotalPixels",
    "inputs": {
     "upscale_method": "lanczos",
     "megapixels": [
      "666",
      0
     ],
     "resolution_steps": 32,
     "image": [
      "475",
      0
     ]
    },
    "_meta": {
     "title": "缩放到约 100 万像素（心宝 1K）"
    }
   },
   "649": {
    "class_type": "TESpeedQwenImage21",
    "inputs": {
     "attention": "kitchen_int8",
     "step_cache": "te_predictor",
     "reuse_threshold": 0.06,
     "start_percent": 0,
     "end_percent": 0,
     "predictor_error_limit": 0.08,
     "verbose": true,
     "model": [
      "661",
      0
     ]
    },
    "_meta": {
     "title": "TESpeedQwenImage21"
    }
   },
   "661": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
     "lora_name": "Qwen\\心宝强化抠图.safetensors",
     "strength_model": 1,
     "model": [
      "476",
      0
     ]
    },
    "_meta": {
     "title": "心宝强化抠图 LoRA"
    }
   },
   "662": {
    "class_type": "PrimitiveString",
    "inputs": {
     "value": "主体"
    },
    "_meta": {
     "title": "物件名（要抠的东西，例如 护肤品、红色价格牌）"
    }
   },
   "663": {
    "class_type": "PrimitiveStringMultiline",
    "inputs": {
     "value": "Xinbao，抠出【{el}】，移除背景和所有外部遮挡物，补全其被遮挡的部分并显示完整主体；保持原有位置、比例、视角、颜色、材质和未遮挡细节不变，输出透明背景PNG。"
    },
    "_meta": {
     "title": "心宝抠图模板（{el} 会换成物件名）"
    }
   },
   "664": {
    "class_type": "StringReplace",
    "inputs": {
     "string": [
      "663",
      0
     ],
     "find": "{el}",
     "replace": [
      "662",
      0
     ]
    },
    "_meta": {
     "title": "StringReplace"
    }
   },
   "666": {
    "class_type": "PrimitiveFloat",
    "inputs": {
     "value": 1
    },
    "_meta": {
     "title": "# 1.抠图分辨率（百万像素，2 ≈ 2K，更细但更慢）"
    }
   }
  },
  "bindings": [
   {
    "role": "output",
    "nodeId": "487",
    "input": "images",
    "classType": "SaveImage",
    "title": "抠出的物件（透明 PNG）",
    "imageIndex": 0
   },
   {
    "role": "image",
    "nodeId": "475",
    "input": "image",
    "classType": "LoadImage",
    "title": "LoadImage",
    "encoding": "rgb"
   },
   {
    "role": "seed",
    "nodeId": "481",
    "input": "seed",
    "classType": "KSampler",
    "title": "KSampler"
   },
   {
    "role": "prompt",
    "nodeId": "662",
    "input": "value",
    "classType": "PrimitiveString",
    "title": "物件名（要抠的东西，例如 护肤品、红色价格牌）",
    "label": "物件名"
   }
  ],
  "options": {
   "allowEmptyPrompt": true,
   "sendScope": "crop",
   "cropMargin": 1,
   "cropDefault": true
  },
  "source": {
   "kind": "builtin"
  }
 }
];

/** Fresh copies of the built-ins not in `profiles` (matched by id, so a re-add never duplicates).
 *  A JSON copy: UXP has no structuredClone (the panel failed to start with it). */
export function missingBuiltins(profiles: readonly Profile[]): Profile[] {
  const have = new Set(profiles.map(p => p.id));
  return BUILTIN_PROFILES.filter(b => !have.has(b.id)).map(b => JSON.parse(JSON.stringify(b)) as Profile);
}
