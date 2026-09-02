$src = "C:/nexus-core-src"
$dst = "C:/Users/Hey!/OneDrive/ドキュメント/New folder"

# Create directories
$dirs = @(
    "src/lib/agent/tools",
    "src/hooks",
    "src/app/api/agent",
    "src/app/actions",
    "src/components",
    "src/types",
    "src/lib/__tests__"
)

foreach ($d in $dirs) {
    $target = Join-Path $dst $d
    if (-not (Test-Path $target)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
    }
}

# Copy files
$files = @(
    "src/lib/agent/types.ts",
    "src/lib/agent/loop.ts",
    "src/lib/agent/permissions.ts",
    "src/lib/agent/workspace.ts",
    "src/lib/agent/tools/registry.ts",
    "src/lib/agent/tools/file-tools.ts",
    "src/lib/agent/tools/shell-tools.ts",
    "src/lib/ai-providers.ts",
    "src/lib/types.ts",
    "src/lib/errors.ts",
    "src/lib/validators.ts",
    "src/lib/file-adapter.ts",
    "src/lib/file-utils.ts",
    "src/lib/file-download.ts",
    "src/lib/logger.ts",
    "src/lib/rate-limiter.ts",
    "src/hooks/useChatSession.ts",
    "src/hooks/useSSEStream.ts",
    "src/hooks/useMessages.ts",
    "src/hooks/useConversation.ts",
    "src/hooks/useAgentChat.ts",
    "src/hooks/useFileProcessor.ts",
    "src/app/api/chat/route.ts",
    "src/app/api/agent/route.ts",
    "src/app/api/health/route.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/globals.css",
    "src/app/settings/page.tsx",
    "src/app/actions/conversations.ts",
    "src/app/actions/settings.ts",
    "src/app/actions/bug-report.ts",
    "src/components/Providers.tsx",
    "src/components/WelcomeSection.tsx",
    "src/components/ChatInput.tsx",
    "src/components/MessageList.tsx",
    "src/components/ModeSelector.tsx",
    "src/components/ToolCallDisplay.tsx",
    "src/components/AgentProgress.tsx",
    "src/middleware.ts",
    "next.config.js",
    "jest.config.js",
    "tsconfig.json",
    "package.json",
    "prisma/schema.prisma",
    "src/lib/__tests__/validators.test.ts",
    "src/lib/__tests__/file-utils.test.ts",
    "src/lib/__tests__/errors.test.ts"
)

foreach ($f in $files) {
    $srcPath = Join-Path $src $f
    $dstPath = Join-Path $dst $f
    if (Test-Path $srcPath) {
        Copy-Item $srcPath $dstPath -Force
        Write-Host "Copied: $f"
    } else {
        Write-Host "MISSING: $f"
    }
}

Write-Host "Done!"
