{
  "targets": [
    {
      "target_name": "keyboard_hook",
      "sources": ["keyboard_hook.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 0
              }
            },
            "libraries": ["user32.lib", "kernel32.lib"],
            "msbuild_toolset": "v143"
          }
        ]
      ]
    }
  ]
}
