import type { BaseAgent } from "./baseAgent";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunTree } from "langsmith";

interface EditorInput {
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
  critique: {
    overallScore: number;
    feedback: {
      strengths: string[];
      weaknesses: string[];
      suggestions: string[];
    };
    contentIssues: Array<{
      type:
        | "structure"
        | "clarity"
        | "accuracy"
        | "style"
        | "seo"
        | "engagement";
      severity: "low" | "medium" | "high";
      location: string;
      issue: string;
      suggestion: string;
    }>;
    seoAnalysis: {
      keywordUsage: string;
      headingStructure: string;
      metaDescription: string;
      suggestedKeywords: string[];
    };
  };
}

interface EditorOutput {
  topic: string;
  title: string; // Potentially improved title
  content: string; // Improved content
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
    metaDescription: string; // Added from SEO analysis
    keywords: string[]; // Added from SEO analysis
  };
  changeLog: Array<{
    type: "title" | "content" | "structure" | "seo";
    description: string;
    before?: string;
    after?: string;
  }>;
}

export class EditorAgent implements BaseAgent {
  id = "editor";
  name = "Content Editor";
  private model: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.model = new ChatOpenAI({
      modelName: "o1-mini",
      // Balanced between creativity and consistency
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

  private validateImprovementPlan(plan: any): void {
    if (!plan.improvementPlan) {
      throw new Error("Missing improvementPlan in response");
    }

    const {
      titleChanges,
      structuralChanges,
      styleImprovements,
      seoOptimizations,
    } = plan.improvementPlan;

    if (typeof titleChanges?.shouldChange !== "boolean") {
      throw new Error("Invalid titleChanges format");
    }

    if (!Array.isArray(structuralChanges)) {
      throw new Error("structuralChanges must be an array");
    }

    if (!Array.isArray(styleImprovements)) {
      throw new Error("styleImprovements must be an array");
    }

    if (
      !seoOptimizations?.keywords ||
      !Array.isArray(seoOptimizations.keywords)
    ) {
      throw new Error("Invalid seoOptimizations format");
    }
  }

  private validateImprovements(improvements: any): void {
    if (!improvements.title || typeof improvements.title !== "string") {
      throw new Error("Missing or invalid title in improvements");
    }

    if (!improvements.content || typeof improvements.content !== "string") {
      throw new Error("Missing or invalid content in improvements");
    }

    if (!Array.isArray(improvements.keyTakeaways)) {
      throw new Error("keyTakeaways must be an array");
    }

    if (!Array.isArray(improvements.changeLog)) {
      throw new Error("changeLog must be an array");
    }
  }

  private calculateReadingTime(content: string): number {
    const wordsPerMinute = 200;
    const wordCount = content.split(/\s+/).length;
    return Math.ceil(wordCount / wordsPerMinute);
  }

  async execute(input: EditorInput): Promise<EditorOutput> {
    const runTree = new RunTree({
      name: "Editor Agent",
      run_type: "chain",
      project_name: "blog-bot",
      inputs: { topic: input.topic },
    });

    try {
      const outputParser = new StringOutputParser();

      // Get the improvement plan
      const planningResponse = await this.model
        .pipe(outputParser)
        .invoke(this.createPlanningPrompt(input));

      const plan = await this.parseJSONSafely(planningResponse);
      this.validateImprovementPlan(plan);

      // Execute the improvements
      const editingResponse = await this.model
        .pipe(outputParser)
        .invoke(this.createEditingPrompt(input, plan));

      const improvements = await this.parseJSONSafely(editingResponse);
      this.validateImprovements(improvements);

      // Calculate updated metadata
      const wordCount = improvements.content.split(/\s+/).length;
      const readingTime = this.calculateReadingTime(improvements.content);

      const output: EditorOutput = {
        topic: input.topic,
        title: improvements.title,
        content: improvements.content,
        metadata: {
          wordCount,
          readingTime,
          targetAudience: input.metadata.targetAudience,
          keyTakeaways: improvements.keyTakeaways,
          sources: input.metadata.sources,
          metaDescription:
            plan.improvementPlan.seoOptimizations.metaDescription,
          keywords: plan.improvementPlan.seoOptimizations.keywords,
        },
        changeLog: improvements.changeLog,
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

  private createPlanningPrompt(input: EditorInput): string {
    return `You are a professional content editor improving a blog post about "${
      input.topic
    }".
Review the critique and plan improvements to the content.

Current Title: ${input.title}
Target Audience: ${input.metadata.targetAudience}

Critique Overview:
- Overall Score: ${input.critique.overallScore}/10
- Strengths: ${input.critique.feedback.strengths.join(", ")}
- Weaknesses: ${input.critique.feedback.weaknesses.join(", ")}
- Suggestions: ${input.critique.feedback.suggestions.join(", ")}

Content Issues:
${input.critique.contentIssues
  .map(
    (issue) =>
      `- ${issue.type.toUpperCase()} (${issue.severity}): ${
        issue.issue
      }\n  Suggestion: ${issue.suggestion}`
  )
  .join("\n")}

SEO Analysis:
${JSON.stringify(input.critique.seoAnalysis, null, 2)}

Original Content:
${input.content}

Respond with a JSON object using this exact structure:
{
    "improvementPlan": {
        "titleChanges": {
            "shouldChange": boolean,
            "reason": "reason for changing or keeping title",
            "newTitle": "new title if should change"
        },
        "structuralChanges": [
            {
                "type": "addition|modification|deletion",
                "location": "where in the content",
                "change": "what to change"
            }
        ],
        "styleImprovements": [
            "improvement 1",
            "improvement 2"
        ],
        "seoOptimizations": {
            "keywords": ["keyword 1", "keyword 2"],
            "metaDescription": "optimized meta description"
        }
    }
}`;
  }

  private createEditingPrompt(input: EditorInput, plan: any): string {
    return `You are improving a blog post based on the following improvement plan:
${JSON.stringify(plan, null, 2)}

Original Content:
${input.content}

Respond with a JSON object using this exact structure:
{
    "title": "final title",
    "content": "improved content in markdown format",
    "keyTakeaways": ["key point 1", "key point 2", "key point 3"],
    "changeLog": [
        {
            "type": "title|content|structure|seo",
            "description": "what was changed",
            "before": "original text if applicable",
            "after": "new text if applicable"
        }
    ]
}

Guidelines:
1. Maintain the original voice and style while improving clarity
2. Ensure all changes align with the critique feedback
3. Optimize for both readability and SEO
4. Keep the content focused and engaging
5. Preserve valuable original content while fixing issues
6. Use markdown formatting appropriately`;
  }
}
