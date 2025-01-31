import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";

interface CritiqueInput {
  topic: string;
  title: string;
  content: string;
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
  };
}

interface CritiqueOutput {
  topic: string;
  overallScore: number; // 0-10
  feedback: {
    strengths: string[];
    weaknesses: string[];
    suggestions: string[];
  };
  contentIssues: Array<{
    type: "structure" | "clarity" | "accuracy" | "style" | "seo" | "engagement";
    severity: "low" | "medium" | "high";
    location: string; // Description of where in the content
    issue: string;
    suggestion: string;
  }>;
  seoAnalysis: {
    keywordUsage: string;
    headingStructure: string;
    metaDescription: string;
    suggestedKeywords: string[];
  };
}

export class CritiquerAgent implements BaseAgent {
  id = "critiquer";
  name = "Content Critiquer";
  private model: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "o1-mini",
      // Lower temperature for more consistent critique
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

  async execute(input: CritiqueInput): Promise<CritiqueOutput> {
    const runTree = new RunTree({
      name: "Critiquer Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // Ensure metadata fields exist with defaults
      const metadata = {
        wordCount: input.metadata?.wordCount ?? 0,
        readingTime: input.metadata?.readingTime ?? 0,
        targetAudience: input.metadata?.targetAudience ?? "General audience",
        keyTakeaways: input.metadata?.keyTakeaways ?? [],
        sources: input.metadata?.sources ?? [],
      };

      // First, analyze the content structure and clarity
      const analysisPrompt = `You are a professional content critic reviewing a blog post about "${
        input.topic
      }".
Analyze this content for structure, clarity, accuracy, style, SEO, and reader engagement.

Title: ${input.title}
Target Audience: ${metadata.targetAudience}
Content:
${input.content}

Key Takeaways:
${
  metadata.keyTakeaways.length > 0
    ? metadata.keyTakeaways.join("\n")
    : "No key takeaways provided"
}

Sources:
${
  metadata.sources.length > 0
    ? metadata.sources.join("\n")
    : "No sources provided"
}

You must respond with a valid JSON object using this exact structure:
{
    "overallScore": number between 0 and 10,
    "feedback": {
        "strengths": ["strength 1", "strength 2", ...],
        "weaknesses": ["weakness 1", "weakness 2", ...],
        "suggestions": ["suggestion 1", "suggestion 2", ...]
    },
    "contentIssues": [
        {
            "type": one of ["structure", "clarity", "accuracy", "style", "seo", "engagement"],
            "severity": one of ["low", "medium", "high"],
            "location": "specific location in the content",
            "issue": "description of the issue",
            "suggestion": "specific suggestion for improvement"
        }
    ],
    "seoAnalysis": {
        "keywordUsage": "analysis of keyword usage and density",
        "headingStructure": "analysis of heading hierarchy and structure",
        "metaDescription": "suggested meta description for the blog post",
        "suggestedKeywords": ["keyword 1", "keyword 2", ...]
    }
}

Guidelines for critique:
1. Be specific and actionable in your feedback
2. Consider the target audience
3. Evaluate source usage and citation
4. Check for logical flow and transitions
5. Assess SEO optimization
6. Evaluate engagement factors

Remember: Your entire response must be a valid JSON object.`;

      const analysisResponse = await this.model
        .pipe(outputParser)
        .invoke(analysisPrompt);

      const critique = await this.parseJSONSafely(analysisResponse);

      // Validate the critique structure
      if (
        !critique.overallScore ||
        !critique.feedback ||
        !critique.contentIssues ||
        !critique.seoAnalysis
      ) {
        throw new Error("Invalid critique format");
      }

      const output: CritiqueOutput = {
        topic: input.topic,
        overallScore: critique.overallScore,
        feedback: critique.feedback,
        contentIssues: critique.contentIssues,
        seoAnalysis: critique.seoAnalysis,
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
