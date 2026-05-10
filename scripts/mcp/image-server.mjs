#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const REPO_ROOT = process.env.GITHUB_WORKSPACE
    ? resolve(process.env.GITHUB_WORKSPACE)
    : process.cwd();

const ALLOWED_SIZES = new Set([
    "1024x1024",
    "1024x1536",
    "1536x1024",
    "auto",
]);
const ALLOWED_QUALITY = new Set(["low", "medium", "high", "auto"]);
const ALLOWED_FORMATS = new Set(["png", "jpeg", "webp"]);

function resolveSafe(outputPath) {
    if (!outputPath || typeof outputPath !== "string") {
        throw new Error("output_path must be a non-empty string");
    }
    const abs = isAbsolute(outputPath)
        ? resolve(outputPath)
        : resolve(REPO_ROOT, outputPath);
    const rel = relative(REPO_ROOT, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
            `output_path must stay inside the repo root (${REPO_ROOT})`,
        );
    }
    return abs;
}

const openai = new OpenAI();

const server = new Server(
    { name: "image-generator", version: "0.1.0" },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "generate_image",
            description:
                "Generate an image from a text prompt with OpenAI gpt-image-1 and write it to a path inside the repository. Use repo-relative paths (e.g. 'public/images/og/post-slug.png').",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            "Description of the image to generate. Be concrete about composition, subject, mood, colours.",
                    },
                    output_path: {
                        type: "string",
                        description:
                            "Repo-relative file path including extension. Parent dirs are created if missing.",
                    },
                    size: {
                        type: "string",
                        enum: [...ALLOWED_SIZES],
                        default: "1024x1024",
                    },
                    quality: {
                        type: "string",
                        enum: [...ALLOWED_QUALITY],
                        default: "high",
                    },
                    format: {
                        type: "string",
                        enum: [...ALLOWED_FORMATS],
                        default: "png",
                        description:
                            "Output encoding. Should match the extension on output_path.",
                    },
                },
                required: ["prompt", "output_path"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "generate_image") {
        throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args = request.params.arguments ?? {};
    const prompt = args.prompt;
    const outputPath = args.output_path;
    const size = args.size ?? "1024x1024";
    const quality = args.quality ?? "high";
    const format = args.format ?? "png";

    if (!prompt || typeof prompt !== "string") {
        throw new Error("prompt must be a non-empty string");
    }
    if (!ALLOWED_SIZES.has(size)) {
        throw new Error(`size must be one of ${[...ALLOWED_SIZES].join(", ")}`);
    }
    if (!ALLOWED_QUALITY.has(quality)) {
        throw new Error(
            `quality must be one of ${[...ALLOWED_QUALITY].join(", ")}`,
        );
    }
    if (!ALLOWED_FORMATS.has(format)) {
        throw new Error(
            `format must be one of ${[...ALLOWED_FORMATS].join(", ")}`,
        );
    }

    const abs = resolveSafe(outputPath);

    const result = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size,
        quality,
        output_format: format,
        n: 1,
    });

    const datum = result?.data?.[0];
    if (!datum?.b64_json) {
        throw new Error("OpenAI response did not include image data");
    }

    const buf = Buffer.from(datum.b64_json, "base64");
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);

    const repoRel = relative(REPO_ROOT, abs).split("\\").join("/");
    return {
        content: [
            {
                type: "text",
                text: `Wrote ${buf.length} bytes to ${repoRel} (${size}, ${quality}, ${format}).`,
            },
        ],
    };
});

const transport = new StdioServerTransport();
await server.connect(transport);
