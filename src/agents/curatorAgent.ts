import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";

interface CurationInput {
  topic: string;
  searchResults: Array<{
    title: string;
    snippet: string;
    link: string;
  }>;
  summary: string;
}

interface CurationOutput {
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

export class CuratorAgent implements BaseAgent {
  id = "curator";
  name = "Content Curator";
  private model: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "o1-mini",
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  private async parseJSONSafely(jsonString: string): Promise<any> {
    try {
      // First try to parse the string directly
      return JSON.parse(jsonString);
    } catch (e) {
      // Look for JSON in markdown code blocks first
      const codeBlockRegex = /```(?:json)?\n([\s\S]*?)\n```/;
      const codeBlockMatch = jsonString.match(codeBlockRegex);

      if (codeBlockMatch && codeBlockMatch[1]) {
        try {
          // Try to parse the content inside the code block
          return JSON.parse(codeBlockMatch[1]);
        } catch (e2) {
          // If that fails, try to clean up the code block content
          const cleanedBlock = codeBlockMatch[1]
            .replace(/\\n/g, " ") // Replace literal \n with space
            .replace(/\n/g, " ") // Replace actual newlines with space
            .replace(/\s+/g, " ") // Normalize whitespace
            .replace(/"\s+}/g, '"}') // Fix spacing in object endings
            .replace(/"\s+,/g, '",') // Fix spacing in property separators
            .replace(/,(\s+})/g, "$1") // Remove trailing commas
            .replace(/\\"/g, '"') // Fix escaped quotes
            .replace(/\\\\/g, "\\") // Fix escaped backslashes
            .trim();

          try {
            return JSON.parse(cleanedBlock);
          } catch (e3) {
            // Continue to next attempt if this fails
          }
        }
      }

      // If no code block or parsing failed, try to find JSON pattern in the whole text
      const jsonPattern = /(\{[\s\S]*?\}|\[[\s\S]*?\])/;
      const jsonMatch = jsonString.match(jsonPattern);

      if (jsonMatch && jsonMatch[1]) {
        try {
          let cleaned = jsonMatch[1]
            .replace(/\\n/g, " ")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .replace(/"\s+}/g, '"}')
            .replace(/"\s+,/g, '",')
            .replace(/,(\s+})/g, "$1")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\")
            .trim();

          return JSON.parse(cleaned);
        } catch (e4) {
          // Log the cleaned content for debugging
          console.error("Failed to parse cleaned JSON:", jsonMatch[1]);
        }
      }

      // If all attempts fail, throw a descriptive error
      console.error("Original content:", jsonString);
      throw new Error(
        "Failed to parse JSON response. The response may not be in the expected format."
      );
    }
  }

  async execute(input: CurationInput): Promise<CurationOutput> {
    const runTree = new RunTree({
      name: "Curator Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // Score and filter the search results
      const scoringPrompt = `You are a content curator evaluating search results for a blog post about "${
        input.topic
      }". 
For each result, analyze its relevance, credibility, and uniqueness. Rate each on a scale of 0-10 and provide a brief reason.

You must respond with a valid JSON array containing objects with the following structure:
[
    {
        "title": "exact title from the result",
        "relevanceScore": number between 0 and 10,
        "reason": "brief explanation"
    },
    ...
]

Here are the results to evaluate:
${input.searchResults
  .map((r) => `Title: ${r.title}\nContent: ${r.snippet}\nURL: ${r.link}\n---`)
  .join("\n")}

Remember: Your entire response must be a valid JSON array.`;

      const scoringResponse = await this.model
        .pipe(outputParser)
        .invoke(scoringPrompt);

      const scoredResults = await this.parseJSONSafely(scoringResponse);

      if (!Array.isArray(scoredResults)) {
        throw new Error("Scoring response is not an array");
      }

      // Filter results and combine with original data
      const selectedResults = input.searchResults
        .map((result, index) => ({
          ...result,
          relevanceScore: scoredResults[index]?.relevanceScore ?? 0,
          reason: scoredResults[index]?.reason ?? "No reason provided",
        }))
        .filter((result) => result.relevanceScore >= 7) // Only keep high-scoring results
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

      // Generate a curated summary and suggested angles
      const curationPrompt = `Based on these highly relevant search results about "${
        input.topic
      }", create a focused summary and suggest unique angles for the blog post.

You must respond with a valid JSON object using this exact structure:
{
    "curatedSummary": "your detailed summary here",
    "suggestedAngles": ["angle 1", "angle 2", "angle 3"]
}

Here are the selected results:
${selectedResults
  .map(
    (r) =>
      `Title: ${r.title}\nContent: ${r.snippet}\nRelevance: ${r.relevanceScore}\nReason: ${r.reason}\n---`
  )
  .join("\n")}

Remember: Your entire response must be a valid JSON object.`;

      const curationResponse = await this.model
        .pipe(outputParser)
        .invoke(curationPrompt);

      const curation = await this.parseJSONSafely(curationResponse);

      if (
        !curation.curatedSummary ||
        !Array.isArray(curation.suggestedAngles)
      ) {
        throw new Error("Invalid curation response format");
      }

      const output: CurationOutput = {
        topic: input.topic,
        selectedResults,
        curatedSummary: curation.curatedSummary,
        suggestedAngles: curation.suggestedAngles,
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
