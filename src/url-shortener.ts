import * as path from 'path';
import { Construct } from 'constructs';
import { Stack, CfnOutput, 
         aws_dynamodb as Dynamodb,
         aws_apigateway as ApiGateway,
         aws_lambda as Lambda,
         aws_certificatemanager as CertificateManager,
         aws_iam as Iam,
         aws_route53 as Route53,
         aws_route53_targets as Route53Targets } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';         

import { hash, getKeySchemaProperty } from './utils';

interface Routes {
  root: ResourceConfiguration;
}

interface ResourceConfiguration {
  childResources?: { [pathPart: string]: ResourceConfiguration };
  methods?: ResourceMethod[];
}

interface ResourceMethod {
  method: string;
  integration: ApiGateway.LambdaIntegration | ApiGateway.MockIntegration;
  methodOptions: ApiGateway.MethodOptions;
}

/**
 * Properties to configure a URL shortener
 */
export interface URLShortenerProps {
  /**
   * The DynamoDB table used for storing links.
   *
   * A static property `defaultDynamoTableProps` is exposed with default
   * partition key set to `id`. You can extend it for your own `TableProps`.
   *
   * @example
   * const tableProps = {
   *   ...URLShortener.defaultDynamoTableProps,
   *   stream: StreamViewType.NEW_AND_OLD_IMAGES,
   * });
   *
   * @default - A new DynamoDB Table is created.
   */
  readonly dynamoTable?: Dynamodb.Table;
}

/**
 * Properties to configure a domain name
 */
export interface CustomDomainOptions {
  /**
   * Domain name to be associated with URL shortener service, supports apex
   * domain and subdomain.
   */
  readonly domainName: string;

  /**
   * Hosted zone of the domain which will be used to create alias record(s)
   * from domain name in the hosted zone to URL shortener API endpoint.
   */
  readonly zone: Route53.IHostedZone;

  /**
   * The AWS Certificate Manager (ACM) certificate that will be associated with
   * the URL shortener that will be created.
   *
   * @default - A new DNS validated certificate is created in the same region.
   */
  readonly certificate?: CertificateManager.ICertificate;
}

/**
 * Represents a URL shortener.
 *
 * Use `addDomainName` to configure a custom domain.
 *
 * By default, this construct will deploy:
 *
 * - An API Gateway API that can be accessed from a public endpoint.
 * - A DynamoDB table for storing links.
 * - A Lambda Function for shortening the link and storing it to DynamoDB table.
 */
export class URLShortener extends Construct {
  private readonly _stack: Stack;
  private readonly _apigw: ApiGateway.RestApi;
  private readonly _dynamoTable: Dynamodb.Table;
  private readonly _dynamoTableKeyName: string;
  private readonly _shortenFn: Lambda.IFunction;

  /**
   * Default table props with partition key set to `id`, you can use it to extend
   * your `TableProps`.
   *
   * @example
   * const tableProps = {
   *   ...URLShortener.defaultDynamoTableProps,
   *   stream: StreamViewType.NEW_AND_OLD_IMAGES,
   * });
   */
  public static readonly defaultDynamoTableProps: Dynamodb.TableProps = {
    partitionKey: {
      name: 'id',
      type: Dynamodb.AttributeType.STRING,
    },
  };

  constructor(scope: Construct, id: string, props?: URLShortenerProps) {
    super(scope, id);

    this._stack = Stack.of(this);
    this._apigw = new ApiGateway.RestApi(this, 'Api', {
      restApiName: `${id}-URLShortener-Api`,
    });
    this._dynamoTable = props?.dynamoTable || this._makeTable();
    this._dynamoTableKeyName = getKeySchemaProperty(
      this._dynamoTable,
      'HASH',
    ).attributeName;
    this._shortenFn = this._makeShortenLambdaFn();

    const validationModel = this._makeValidationModel(this._apigw);
    const apigwDynamodbRole = this._makeRole(this._dynamoTable.tableArn);
    this._makeUsagePlan(this._apigw);
    const routes: Routes = {
      root: {
        childResources: {
          '{id}': {
            methods: [
              {
                method: 'GET',
                integration: new ApiGateway.AwsIntegration({
                  service: 'dynamodb',
                  action: 'UpdateItem',
                  options: {
                    credentialsRole: apigwDynamodbRole,
                    passthroughBehavior: ApiGateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
                    integrationResponses: [
                      {
                        selectionPattern: '200',
                        responseParameters: {
                          'method.response.header.Location':
                            'integration.response.body.Attributes.url.S',
                          'method.response.header.Content-Type':
                            "'text/html; charset=UTF-8'",
                        },
                        responseTemplates: {
                          'text/html; charset=UTF-8': [
                            "#if($input.path('$.Attributes.url.S').isEmpty() == false)",
                            "#set($url = $input.path('$.Attributes.url.S'))",
                            '#set($context.responseOverride.header.Location = $url)',
                            '<!DOCTYPE html><html><head><meta charset="UTF-8" />',
                            '<meta http-equiv="refresh" content="0;url=$url" />',
                            '<title>Redirecting to $url</title></head>',
                            '<body>Redirecting to <a href="$url">$url</a>.</body></html>',
                            '#else',
                            '#set($context.responseOverride.status = 404)',
                            '#end',
                          ].join(''),
                        },
                        statusCode: '301',
                      },
                      {
                        statusCode: '404',
                        responseTemplates: {
                          'text/html': 'Not Found',
                        },
                      },
                    ],
                    requestTemplates: {
                      'application/json': JSON.stringify({
                        TableName: this._dynamoTable.tableName,
                        Key: {
                          [this._dynamoTableKeyName]: {
                            S: "$input.params('id')",
                          },
                        },
                        UpdateExpression:
                          'set clicks = clicks + :num, last_click_ts = :rt',
                        ConditionExpression: `attribute_exists(${this._dynamoTableKeyName})`,
                        ProjectionExpression: `${this._dynamoTableKeyName}, url`,
                        ExpressionAttributeValues: {
                          ':num': {
                            N: '1',
                          },
                          ':rt': {
                            N: '$context.requestTimeEpoch',
                          },
                        },
                        ReturnValues: 'ALL_NEW',
                      }),
                    },
                  },
                }),
                methodOptions: {
                  methodResponses: [
                    {
                      responseParameters: {
                        'method.response.header.Location': true,
                        'method.response.header.Content-Type': true,
                      },
                      statusCode: '301',
                    },
                    {
                      statusCode: '404',
                    },
                  ],
                },
              },
            ],
          },
        },
        methods: [
          {
            method: 'GET',
            integration: new ApiGateway.MockIntegration({
              passthroughBehavior: ApiGateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
              integrationResponses: [
                {
                  statusCode: '404',
                  responseTemplates: {
                    'text/html': 'Not Found',
                  },
                },
              ],
              requestTemplates: {
                'application/json': JSON.stringify({
                  statusCode: 404,
                }),
              },
            }),
            methodOptions: {
              methodResponses: [
                {
                  responseParameters: {
                    'method.response.header.Location': true,
                    'method.response.header.Content-Type': true,
                  },
                  statusCode: '301',
                },
                {
                  statusCode: '404',
                },
              ],
            },
          },
          {
            method: 'POST',
            integration: new ApiGateway.LambdaIntegration(this._shortenFn),
            methodOptions: {
              requestParameters: {
                'method.request.header.Content-Type': true,
              },
              requestValidatorOptions: {
                validateRequestBody: true,
              },
              requestModels: {
                'application/json': validationModel,
              },
              apiKeyRequired: true,
            },
          },
        ],
      },
    };
    this._buildApiGateway(this._apigw.root, routes.root);
  }

  private _buildApiGateway(
    parentResource: ApiGateway.IResource,
    resourceConfiguration: ResourceConfiguration,
  ) {
    const { childResources = {}, methods = [] } = resourceConfiguration;

    methods.forEach(({ method, integration, methodOptions }) => {
      parentResource.addMethod(method, integration, methodOptions);
    });

    Object.entries(childResources).forEach(
      ([pathPart, resourceConfiguration]) => {
        const childResource = parentResource.addResource(pathPart);
        this._buildApiGateway(childResource, resourceConfiguration);
      },
    );
  }

  private _makeTable(): Dynamodb.Table {
    return new Dynamodb.Table(this, 'Table', URLShortener.defaultDynamoTableProps);
  }

  private _makeShortenLambdaFn() {
    const fn = new NodejsFunction(this, 'Function', {
      runtime: Lambda.Runtime.NODEJS_12_X,
      handler: 'handler',
      entry: path.join(__dirname, 'lambda-fns/shorten/index.ts'),
      memorySize: 1024,
      environment: {
        TABLE_NAME: this._dynamoTable.tableName,
        KEY_NAME: this._dynamoTableKeyName,
      },
    });    

    this._dynamoTable.grantWriteData(fn);
    return fn;
  }

  private _makeValidationModel(api: ApiGateway.RestApi) {
    return api.addModel('ValidationModel', {
      modelName: 'ValidationModel',
      schema: {
        schema: ApiGateway.JsonSchemaVersion.DRAFT4,
        type: ApiGateway.JsonSchemaType.OBJECT,
        properties: {
          url: {
            type: ApiGateway.JsonSchemaType.STRING,
            format: 'uri',
            pattern: '^https?://',
          },
        },
        required: ['url'],
      },
      contentType: 'application/json',
    });
  }

  private _makeRole(tableArn: string) {
    return new Iam.Role(this, 'Role', {
      assumedBy: new Iam.ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        APIGatewayDynamoDBUpdateItem: new Iam.PolicyDocument({
          statements: [
            new Iam.PolicyStatement({
              actions: ['dynamodb:UpdateItem'],
              resources: [tableArn],
            }),
          ],
        }),
      },
    });
  }

  private _makeUsagePlan(api: ApiGateway.RestApi) {
    const apiKey = api.addApiKey('ApiKey', {
      apiKeyName: `${this._stack.stackName}-URLShortener-ApiKey`,
    });

    new CfnOutput(this, 'ApiKeyURL', {
      value: `https://console.aws.amazon.com/apigateway/home?region=${this._stack.region}#/api-keys/${apiKey.keyId}`,
    });

    const plan = api
      .addUsagePlan('UsagePlan', {
        name: `${this._stack.stackName}-URLShortener-UsagePlan`,
        description: `Usage plan for ${this._stack.stackName} url shortener api`,
      });

    plan.addApiStage({
        stage: api.deploymentStage,
      });

    plan.addApiKey(apiKey);

    return plan;
  }

  addDomainName(options: CustomDomainOptions): this {
    const { zone, domainName, certificate } = options;
    const domainNameHash = hash(domainName);

    const domain = new ApiGateway.DomainName(this, `DomainName${domainNameHash}`, {
      domainName,
      certificate:
        certificate ||
        new CertificateManager.DnsValidatedCertificate(
          this,
          `DnsValidatedCertificate${domainNameHash}`,
          {
            domainName,
            hostedZone: zone,
          },
        ),
    });
    domain.addBasePathMapping(this._apigw);

    const aliasRecord = new Route53.ARecord(this, `AliasRecord${domainNameHash}`, {
      zone,
      recordName: domainName,
      target: Route53.RecordTarget.fromAlias(new Route53Targets.ApiGatewayDomain(domain)),
    });

    new CfnOutput(this, `CustomDomainApiEndpoint${domainNameHash}`, {
      value: `https://${aliasRecord.domainName}`,
    });

    return this;
  }
}
