import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";

interface WriterInput {
  topic: string;
  selectedResults: Array<{
    title: string;
    snippet: string;
    link: string;
    relevanceScore: number;
    reason: string;
  }>;
  curatedSummary: string;
  suggestedAngles: string[];
}

interface WriterOutput {
  topic: string;
  title: string;
  content: string;
  metadata: {
    wordCount: number;
    readingTime: number; // in minutes
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[]; // URLs used
  };
}

export class WriterAgent implements BaseAgent {
  id = "writer";
  name = "Blog Writer";
  private model: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.7, // Slightly higher for more creative writing
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
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

  private calculateReadingTime(content: string): number {
    const wordsPerMinute = 200;
    const wordCount = content.split(/\s+/).length;
    return Math.ceil(wordCount / wordsPerMinute);
  }

  async execute(input: WriterInput): Promise<WriterOutput> {
    const runTree = new RunTree({
      name: "Writer Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // First, generate a blog post structure and title
      const structurePrompt = `You are a professional blog writer creating a post about "${
        input.topic
      }".
Based on the following curated information and suggested angles, create a blog post structure and title.

Curated Summary:
${input.curatedSummary}

Suggested Angles:
${input.suggestedAngles.join("\n")}

You must respond with a valid JSON object using this exact structure:
{
    "title": "engaging blog post title",
    "targetAudience": "description of target audience",
    "outline": [
        {
            "section": "section name",
            "key_points": ["point 1", "point 2", ...]
        },
        ...
    ]
}

Remember: Your entire response must be a valid JSON object.`;

      const structureResponse = await this.model
        .pipe(outputParser)
        .invoke(structurePrompt);

      const structure = await this.parseJSONSafely(structureResponse);

      // Then, write the full blog post
      const writingPrompt = `You are writing a professional blog post about "${
        input.topic
      }".
Use the following structure and source material to write a comprehensive, engaging post.

Title: ${structure.title}
Target Audience: ${structure.targetAudience}

Structure:
${JSON.stringify(structure.outline, null, 2)}

Source Material:
${input.selectedResults
  .map(
    (r) =>
      `Title: ${r.title}\nContent: ${r.snippet}\nRelevance: ${r.relevanceScore}\nReason: ${r.reason}\nURL: ${r.link}\n---`
  )
  .join("\n")}

You must respond with a valid JSON object using this exact structure:
{
    "content": "full blog post content in markdown format",
    "keyTakeaways": ["key point 1", "key point 2", "key point 3"]
}

Guidelines:
1. Write in a clear, engaging style
2. Include relevant statistics and quotes from sources
3. Use markdown formatting for headers, lists, etc.
4. Aim for ~1000-1500 words
5. Include proper attribution for sources
6. Break up text with subheadings for readability

Remember: Your entire response must be a valid JSON object.`;

      const writingResponse = await this.model
        .pipe(outputParser)
        .invoke(writingPrompt);

      const blogPost = await this.parseJSONSafely(writingResponse);

      // Calculate metadata
      const wordCount = blogPost.content.split(/\s+/).length;
      const readingTime = this.calculateReadingTime(blogPost.content);
      const sources = input.selectedResults.map((r) => r.link);

      // Ensure all metadata fields are properly initialized
      const output: WriterOutput = {
        topic: input.topic,
        title: structure.title,
        content: blogPost.content,
        metadata: {
          wordCount: wordCount || 0,
          readingTime: readingTime || 0,
          targetAudience: structure.targetAudience || "General audience",
          keyTakeaways: Array.isArray(blogPost.keyTakeaways)
            ? blogPost.keyTakeaways
            : [],
          sources: Array.isArray(sources) ? sources : [],
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
