import { Stack, CfnOutput, aws_s3 as s3, aws_glue as glue, aws_athena as athena, aws_iam as iam, aws_ssm as ssm } from 'aws-cdk-lib';
export class CoreStack extends Stack {
    constructor(scope, id, props = {}) {
        super(scope, id, props);
        // S3 buckets
        this.rawBucket = new s3.Bucket(this, 'RawBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.KMS_MANAGED,
            bucketKeyEnabled: true,
            enforceSSL: true,
        });
        this.reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.KMS_MANAGED,
            bucketKeyEnabled: true,
            enforceSSL: true,
        });
        // Glue Database
        this.glueDatabaseName = `${this.stackName.toLowerCase()}-msp_growth_db`;
        const glueDb = new glue.CfnDatabase(this, 'GlueDatabase', {
            catalogId: this.account,
            databaseInput: { name: 'msp_growth_db' },
        });
        // Glue Crawler - read from raw bucket (raw/ and policies/)
        const crawlerRole = new iam.Role(this, 'GlueCrawlerRole', {
            assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
            ],
        });
        // S3 read to raw bucket
        crawlerRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
                this.rawBucket.bucketArn,
                this.rawBucket.arnForObjects('*'),
            ],
        }));
        const crawler = new glue.CfnCrawler(this, 'RawDataCrawler', {
            role: crawlerRole.roleArn,
            databaseName: 'msp_growth_db',
            targets: {
                s3Targets: [
                    { path: `s3://${this.rawBucket.bucketName}/raw/` },
                    { path: `s3://${this.rawBucket.bucketName}/policies/` },
                ],
            },
            name: `raw-data-crawler-${this.stackName}`,
            schemaChangePolicy: {
                deleteBehavior: 'LOG',
                updateBehavior: 'UPDATE_IN_DATABASE',
            },
        });
        crawler.addDependency(glueDb);
        // Athena WorkGroup
        const wg = new athena.CfnWorkGroup(this, 'AthenaWG', {
            name: 'msp_growth_wg',
            workGroupConfiguration: {
                enforceWorkGroupConfiguration: true,
                resultConfiguration: {
                    outputLocation: this.reportsBucket.s3UrlForObject('athena/'),
                },
            },
        });
        this.athenaWorkGroupName = wg.name;
        // SSM Parameters
        new ssm.StringParameter(this, 'ParamRawBucket', {
            parameterName: `/msp-growth-os/${this.stackName}/raw-bucket-name`,
            stringValue: this.rawBucket.bucketName,
        });
        new ssm.StringParameter(this, 'ParamReportsBucket', {
            parameterName: `/msp-growth-os/${this.stackName}/reports-bucket-name`,
            stringValue: this.reportsBucket.bucketName,
        });
        new ssm.StringParameter(this, 'ParamGlueDb', {
            parameterName: `/msp-growth-os/${this.stackName}/glue-database-name`,
            stringValue: 'msp_growth_db',
        });
        new ssm.StringParameter(this, 'ParamAthenaWg', {
            parameterName: `/msp-growth-os/${this.stackName}/athena-workgroup-name`,
            stringValue: this.athenaWorkGroupName,
        });
        // Outputs
        new CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName, exportName: `${this.stackName}:RawBucketName` });
        new CfnOutput(this, 'ReportsBucketName', { value: this.reportsBucket.bucketName, exportName: `${this.stackName}:ReportsBucketName` });
        new CfnOutput(this, 'GlueDatabaseName', { value: 'msp_growth_db', exportName: `${this.stackName}:GlueDatabaseName` });
        new CfnOutput(this, 'AthenaWorkGroupName', { value: this.athenaWorkGroupName, exportName: `${this.stackName}:AthenaWorkGroupName` });
        // Create helper prefixes handled by Custom Resource in TS source
    }
}
//# sourceMappingURL=core-stack.js.map