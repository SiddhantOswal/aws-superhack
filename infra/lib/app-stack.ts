import {
  Duration,
  Stack,
  StackProps,
  CfnOutput,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_apigateway as apigw,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AppStackProps extends StackProps {
  coreResources: {
    rawBucketName: string;
    reportsBucketName: string;
    glueDatabaseName: string;
    athenaWorkGroupName: string;
  };
}

export class AppStack extends Stack {
  public readonly actionsTable: dynamodb.Table;
  public readonly controlsTable: dynamodb.Table;
  public readonly api: apigw.RestApi;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // DynamoDB tables
    this.actionsTable = new dynamodb.Table(this, 'ActionsLedger', {
      tableName: 'actions_ledger',
      partitionKey: { name: 'action_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.actionsTable.addGlobalSecondaryIndex({
      indexName: 'gsi_client_id',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
    });
    this.actionsTable.addGlobalSecondaryIndex({
      indexName: 'gsi_status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    this.controlsTable = new dynamodb.Table(this, 'Controls', {
      tableName: 'controls',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // pk: client_id#category
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const lambdaDirs = [
      'policy-evaluator',
      'draft-change-order',
      'approve-action',
      'shelfware-report',
      'underbilling-report',
      'qbr-pdf',
      'athena-bootstrap',
    ];

    const functions: Record<string, lambdaNode.NodejsFunction> = {};
    for (const dir of lambdaDirs) {
      functions[dir] = new lambdaNode.NodejsFunction(this, `${dir}Fn`, {
        entry: path.join(process.cwd(), '..', 'lambdas', dir, 'src', 'index.ts'),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.seconds(30),
        bundling: { externalModules: ['aws-sdk'] },
        environment: {
          RAW_BUCKET: props.coreResources.rawBucketName,
          REPORTS_BUCKET: props.coreResources.reportsBucketName,
          ATHENA_DB: props.coreResources.glueDatabaseName,
          ATHENA_WORKGROUP: props.coreResources.athenaWorkGroupName,
          DDB_ACTIONS: this.actionsTable.tableName,
          DDB_CONTROLS: this.controlsTable.tableName,
          BEDROCK_REGION: 'us-east-1',
          EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@example.com',
        },
      });
      this.actionsTable.grantReadWriteData(functions[dir]);
      this.controlsTable.grantReadWriteData(functions[dir]);
    }

    // Least-privilege IAM: S3 and Athena
    const s3ReadWriteReports = new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${props.coreResources.reportsBucketName}`,
        `arn:aws:s3:::${props.coreResources.reportsBucketName}/*`,
      ],
    });
    const s3ReadRaw = new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${props.coreResources.rawBucketName}`,
        `arn:aws:s3:::${props.coreResources.rawBucketName}/*`,
      ],
    });
    const athenaPolicy = new iam.PolicyStatement({
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
      ],
      resources: ['*'], // scope by workgroup condition
      conditions: {
        StringEquals: {
          'athena:WorkGroup': props.coreResources.athenaWorkGroupName,
        },
      },
    });

    // Attach policies to relevant lambdas
    const reportWriters = ['shelfware-report', 'underbilling-report', 'qbr-pdf', 'draft-change-order'];
    for (const name of reportWriters) {
      functions[name].addToRolePolicy(s3ReadWriteReports);
      functions[name].addToRolePolicy(s3ReadRaw);
      functions[name].addToRolePolicy(athenaPolicy);
    }
    functions['athena-bootstrap'].addToRolePolicy(s3ReadWriteReports);
    functions['athena-bootstrap'].addToRolePolicy(athenaPolicy);
    functions['policy-evaluator'].addToRolePolicy(s3ReadRaw);

    // Step Functions: SmartSOWsCOFlow
    const draftTask = new tasks.LambdaInvoke(this, 'DraftChangeOrder', {
      lambdaFunction: functions['draft-change-order'],
      outputPath: '$.Payload',
    });
    const pendingTask = new tasks.LambdaInvoke(this, 'WritePendingAction', {
      lambdaFunction: functions['approve-action'],
      payload: sfn.TaskInput.fromObject({ 
        mode: 'PENDING',
        action_id: sfn.JsonPath.stringAt('$.action_id'),
        draft_s3_key: sfn.JsonPath.stringAt('$.draft_s3_key'),
        co_json: sfn.JsonPath.objectAt('$.co_json')
      }),
      outputPath: '$.Payload',
    });
    this.stateMachine = new sfn.StateMachine(this, 'SmartSOWsCOFlow', {
      definitionBody: sfn.DefinitionBody.fromChainable(draftTask.next(pendingTask)),
      timeout: Duration.minutes(5),
    });

    // Allow policy-evaluator to start the flow
    functions['policy-evaluator'].addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );

    // API Gateway routes
    this.api = new apigw.RestApi(this, 'Api', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
      },
    });
    this.api.root.addResource('admin').addResource('bootstrap').addMethod('POST', new apigw.LambdaIntegration(functions['athena-bootstrap']));
    this.api.root.addResource('actions').addResource('{action_id}').addResource('approve').addMethod('POST', new apigw.LambdaIntegration(functions['approve-action']));
    this.api.root.addResource('ledger').addMethod('GET', new apigw.LambdaIntegration(functions['approve-action']));
    const reports = this.api.root.addResource('reports');
    reports.addResource('shelfware').addMethod('GET', new apigw.LambdaIntegration(functions['shelfware-report']));
    reports.addResource('underbilling').addMethod('GET', new apigw.LambdaIntegration(functions['underbilling-report']));
    this.api.root.addResource('qbr').addResource('pdf').addMethod('POST', new apigw.LambdaIntegration(functions['qbr-pdf']));

    // EventBridge schedule every 5 minutes → policy-evaluator
    new events.Rule(this, 'PolicyEvalSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(functions['policy-evaluator'])],
    });

    // Outputs
    new CfnOutput(this, 'ApiUrl', { value: this.api.url ?? 'n/a' });
    new CfnOutput(this, 'ActionsTableName', { value: this.actionsTable.tableName });
    new CfnOutput(this, 'ControlsTableName', { value: this.controlsTable.tableName });
    new CfnOutput(this, 'RawBucketNameOut', { value: props.coreResources.rawBucketName });
    new CfnOutput(this, 'ReportsBucketNameOut', { value: props.coreResources.reportsBucketName });
  }
}


