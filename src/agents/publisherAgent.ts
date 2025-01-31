import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";
import * as fs from "fs/promises";
import * as path from "path";
import * as child_process from "child_process";
import { promisify } from "util";

const exec = promisify(child_process.exec);

interface PublisherInput {
  topic: string;
  title: string;
  content: string;
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
    metaDescription: string;
    keywords: string[];
  };
  changeLog: Array<{
    type: "title" | "content" | "structure" | "seo";
    description: string;
    before?: string;
    after?: string;
  }>;
}

interface PublisherOutput {
  topic: string;
  title: string;
  filePath: string;
  publishedDate: string;
  url: string; // GitHub Pages URL
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
    metaDescription: string;
    keywords: string[];
    publishedDate: string;
    lastModified: string;
  };
}

export class PublisherAgent implements BaseAgent {
  id = "publisher";
  name = "Content Publisher";
  private model: ChatOpenAI;
  private outputDir: string;
  private githubUsername?: string;
  private repoName: string;

  constructor(
    outputDir: string = "_posts",
    githubUsername?: string,
    repoName: string = "blog"
  ) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 1, // Default temperature for o1
      openAIApiKey: process.env.OPENAI_API_KEY,
    });

    this.outputDir = outputDir;
    this.githubUsername = githubUsername;
    this.repoName = repoName;
  }

  private async parseJSONSafely(jsonString: string): Promise<any> {
    try {
      return JSON.parse(jsonString);
    } catch (e) {
      const jsonMatch = jsonString.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e2) {
          throw new Error(`Failed to parse JSON response: ${jsonString}`);
        }
      }
      throw new Error(`No valid JSON found in response: ${jsonString}`);
    }
  }

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  private async ensureOutputDirectory(): Promise<void> {
    try {
      await fs.access(this.outputDir);
    } catch {
      await fs.mkdir(this.outputDir, { recursive: true });
    }
  }

  private formatDate(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  private async initializeGitHubPages(): Promise<void> {
    // Check if _config.yml exists
    try {
      await fs.access("_config.yml");
    } catch {
      // Create basic Jekyll configuration
      const jekyllConfig = `
title: AI-Generated Blog
description: Automatically generated blog posts using AI
author: ${this.githubUsername}
theme: minima
plugins:
  - jekyll-feed
  - jekyll-seo-tag

permalink: /:year/:month/:day/:title/
markdown: kramdown
kramdown:
  input: GFM
  syntax_highlighter: rouge

defaults:
  -
    scope:
      path: ""
      type: "posts"
    values:
      layout: "post"
      author: ${this.githubUsername}
`;
      await fs.writeFile("_config.yml", jekyllConfig);
    }

    // Check if index.md exists
    try {
      await fs.access("index.md");
    } catch {
      // Create homepage
      const homepage = `---
layout: home
title: Welcome to Our Blog
---

Welcome to our AI-generated blog! Here you'll find interesting articles about various topics.
`;
      await fs.writeFile("index.md", homepage);
    }

    // Initialize git if needed
    try {
      await exec("git status");
    } catch {
      await exec("git init");
      await exec(
        `git remote add origin https://github.com/${this.githubUsername}/${this.repoName}.git`
      );
    }
  }

  async execute(input: PublisherInput): Promise<PublisherOutput> {
    const runTree = new RunTree({
      name: "Publisher Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // Format the content with proper frontmatter
      const formattingPrompt = `You are preparing a blog post for publication in Jekyll-compatible markdown format.
Create a properly formatted markdown file with frontmatter for the following content.

Title: ${input.title}
Topic: ${input.topic}
Metadata:
${JSON.stringify(input.metadata, null, 2)}

Content:
${input.content}

You must respond with a valid JSON object using this exact structure:
{
    "formattedContent": "complete markdown content with Jekyll frontmatter",
    "excerpt": "brief excerpt for the blog post"
}

Guidelines:
1. Include Jekyll frontmatter with layout: post
2. Add all metadata in the frontmatter
3. Format content in proper markdown
4. Generate a brief excerpt
5. Include proper attribution for sources
6. Add categories and tags based on keywords

Remember: Your entire response must be a valid JSON object.`;

      const formattingResponse = await this.model
        .pipe(outputParser)
        .invoke(formattingPrompt);

      const formatted = await this.parseJSONSafely(formattingResponse);

      // Initialize GitHub Pages structure if needed
      if (this.githubUsername) {
        await this.initializeGitHubPages();
      }

      // Prepare file path and metadata
      const publishedDate = this.formatDate(new Date());
      const slug = this.generateSlug(input.title);
      const fileName = `${publishedDate}-${slug}.md`;
      const filePath = path.join(this.outputDir, fileName);

      // Ensure output directory exists
      await this.ensureOutputDirectory();

      // Write the file
      await fs.writeFile(filePath, formatted.formattedContent, "utf8");

      // If GitHub username is provided, commit and push changes
      if (this.githubUsername) {
        await exec("git add .");
        await exec(`git commit -m "Published: ${input.title}"`);
        await exec("git push origin main");
      }

      const output: PublisherOutput = {
        topic: input.topic,
        title: input.title,
        filePath,
        publishedDate,
        url: this.githubUsername
          ? `https://${this.githubUsername}.github.io/${
              this.repoName
            }/${publishedDate.replace(/-/g, "/")}/${slug}`
          : `file://${path.resolve(filePath)}`,
        metadata: {
          ...input.metadata,
          publishedDate,
          lastModified: publishedDate,
        },
      };

      runTree.end({ outputs: output });
      await runTree.postRun();

      return output;
    } catch (error) {
      runTree.end({ error });
      await runTree.postRun();
      throw error;
    }
  }
}
