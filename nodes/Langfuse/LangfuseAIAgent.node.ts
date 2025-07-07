import { INodeType, INodeTypeDescription, NodeConnectionType, INodeExecutionData, IExecuteFunctions, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

export async function getPrompts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	try {
		// Get credentials
		const credentials = await this.getCredentials('langfuseApi');

		// Create Basic Auth header
		const credentialsString = `${credentials.publicKey}:${credentials.secretKey}`;
		const authHeader = 'Basic ' + Buffer.from(credentialsString).toString('base64');

		// Make API request to fetch prompts
		const response = await this.helpers.httpRequest({
			method: 'GET',
			url: `${credentials.host}/api/public/v2/prompts`,
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
		});

		// Convert to n8n options format
		const options: INodePropertyOptions[] = response.data?.map((prompt: any) => ({
			name: prompt.name,
			value: prompt.name,
			description: prompt.description || `Prompt: ${prompt.name}`,
		})) || [];

		return options;
	} catch (error) {
		console.error('Error fetching prompts:', error);
		return [];
	}
}

export class LangfuseAIAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Langfuse AI Agent',
		name: 'langfuseAIAgent',
		icon: 'file:langfuse.svg',
		group: ['transform'],
		version: 1,
		description: 'Run an AI Agent with Langfuse prompt management and tracing',
		defaults: {
			name: 'AI Agent (Langfuse)',
		},
		inputs: [NodeConnectionType.Main,
			{
				type: NodeConnectionType.AiLanguageModel,
				required: true,
				displayName: 'Chat Model',
				maxConnections: 1,
			},
			{
				type: NodeConnectionType.AiOutputParser,
				required: true,
				displayName: 'Output Parser',
				maxConnections: 1,
			},
		],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'langfuseApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: '={{$credentials.host}}',
		},
		properties: [
			{
				displayName: 'Prompt Name',
				name: 'promptName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getPrompts',
				},
				required: true,
				default: '',
				description: 'The name of the prompt to retrieve from Langfuse',
			},
			{
				displayName: 'Prompt Parameters',
				name: 'promptParameters',
				type: 'string',
				required: true,
				default: '{}',
				description: 'Parameters to pass to the prompt (as JSON object)',
			},
		],
	};

	methods = {
		loadOptions: {
			getPrompts,
		}
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Import required packages
		const { PromptTemplate } = await import('@langchain/core/prompts');
		const { RunnableSequence } = await import('@langchain/core/runnables');
		const { Langfuse, CallbackHandler } = await import('langfuse-langchain');

		// Get credentials and cast to string
		const credentials = await this.getCredentials('langfuseApi');
		const langfuseParams = {
			publicKey: String(credentials.publicKey),
			secretKey: String(credentials.secretKey),
			baseUrl: String(credentials.host),
		};
		const langfuse = new Langfuse(langfuseParams);
		const callbackHandler = new CallbackHandler(langfuseParams);

		// Get node parameters
		const promptName = this.getNodeParameter('promptName', 0) as string;
		const promptParameters = JSON.parse(this.getNodeParameter('promptParameters', 0) as string) as Record<string, any>;

		// Get prompt from Langfuse
		const prompt = await langfuse.getPrompt(promptName);
		const promptTemplate = PromptTemplate.fromTemplate(prompt.getLangchainPrompt()).withConfig({ metadata: { langfusePrompt: prompt } });

		// Get input data (Main input)
		const items = this.getInputData(0);

		// Get model and output parser from input connections (by index)
		const model = await this.getInputConnectionData(NodeConnectionType.AiLanguageModel, 0);
		const outputParser = await this.getInputConnectionData(NodeConnectionType.AiOutputParser, 0);

		// Cast to any for method access
		const modelWithStructure = (model as any).withStructuredOutput((outputParser as any).lc_kwargs);

		// Build the chain
		const chain = RunnableSequence.from([promptTemplate, modelWithStructure]);

		// Run the chain for each item
		const results: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			const result = await chain.invoke(
					promptParameters,
				{
					callbacks: [callbackHandler],
					metadata: {
						langfuseUserId: this.getExecutionId(),
						langfuseSessionId: this.getExecutionId(),
					},
				}
			);
			results.push({ json: result });
		}
		return [results];
	}
}
